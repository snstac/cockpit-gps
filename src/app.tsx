/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Cockpit GPS — live GNSS readout sourced from gpsd via `gpspipe -w`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

/* ---- gpsd JSON shapes (subset of the GPSD JSON protocol we care about) ---- */

interface Tpv {
    class: "TPV";
    mode?: number;          // 0=unknown 1=no fix 2=2D 3=3D
    lat?: number;
    lon?: number;
    altMSL?: number;
    altHAE?: number;
    alt?: number;
    speed?: number;         // m/s
    track?: number;         // degrees true
    climb?: number;         // m/s
    time?: string;          // ISO 8601 UTC
    epx?: number;           // longitude error, metres
    epy?: number;           // latitude error, metres
    epv?: number;           // altitude error, metres
}

interface Sat {
    PRN?: number;
    gnssid?: number;
    svid?: number;
    used?: boolean;
    el?: number;            // elevation, degrees
    az?: number;            // azimuth, degrees
    ss?: number;            // signal strength, dB-Hz
}

interface Sky {
    class: "SKY";
    satellites?: Sat[];
    hdop?: number;
    vdop?: number;
    pdop?: number;
    uSat?: number;          // satellites used
    nSat?: number;          // satellites seen
}

interface GpsdState {
    tpv: Tpv | null;
    sky: Sky | null;
    error: string | null;
    running: boolean;
}

/* ---- streaming hook: keep `gpspipe -w` running and parse its NDJSON ---- */

function useGpsd(): GpsdState {
    const [tpv, setTpv] = useState<Tpv | null>(null);
    const [sky, setSky] = useState<Sky | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    // Most-complete SKY seen since the last UI flush. gpsd streams several
    // partial SKY reports per cycle (a satellite-less summary, then a list that
    // builds up incrementally), so we coalesce to the richest one and push it
    // to the UI on a fixed cadence — otherwise the satellite count flip-flops.
    const bestSky = useRef<Sky | null>(null);
    // Likewise for TPV: this receiver spreads its fix across RMC/GGA/GSA/GLL, so
    // gpsd emits several TPVs per second — the first bare (no altitude/error),
    // the last complete. Keep the most-complete one to stop altitude and the
    // error estimate from blinking on and off.
    const bestTpv = useRef<Tpv | null>(null);

    useEffect(() => {
        let buffer = "";
        // gpspipe connects to gpsd on localhost:2947 and emits one JSON object per line.
        const proc = cockpit.spawn(["gpspipe", "-w"], { err: "message" });
        setRunning(true);
        setError(null);

        proc.stream((data: string) => {
            buffer += data;
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim())
                    continue;
                let obj: { class?: string;[k: string]: unknown };
                try {
                    obj = JSON.parse(line);
                } catch {
                    continue;
                }
                if (obj.class === "TPV") {
                    // Keep the most-complete TPV this interval (see bestTpv note).
                    const t = obj as unknown as Tpv;
                    if (tpvScore(t) >= tpvScore(bestTpv.current))
                        bestTpv.current = t;
                } else if (obj.class === "SKY") {
                    // Keep only the richest satellite list this interval; ignore
                    // the satellite-less summary reports that would zero it out.
                    const s = obj as unknown as Sky;
                    const len = s.satellites?.length ?? 0;
                    if (len > 0 && len >= (bestSky.current?.satellites?.length ?? 0))
                        bestSky.current = s;
                } else if (obj.class === "ERROR") {
                    setError(String(obj.message ?? _("gpsd reported an error")));
                }
            }
        });

        proc.then(() => setRunning(false))
                .catch((ex: { message?: string }) => {
                    setError(ex?.message || _("Could not run gpspipe — is gpsd installed and running?"));
                    setRunning(false);
                });

        // Push the coalesced TPV/SKY to the UI once a second; reset afterwards
        // so values dropping out (a constellation, a lost fix) are reflected.
        const flush = window.setInterval(() => {
            if (bestTpv.current) {
                const t = bestTpv.current;
                setTpv(prev => ({ ...(prev ?? {}), ...t }));
                bestTpv.current = null;
            }
            if (bestSky.current) {
                setSky(bestSky.current);
                bestSky.current = null;
            }
        }, 1000);

        return () => {
            window.clearInterval(flush);
            try {
                proc.close("cancelled");
            } catch { /* already gone */ }
        };
    }, []);

    return { tpv, sky, error, running };
}

/* ---- integrity monitor (gps-integrity daemon) ---- */

interface IntegrityCheck {
    status: string;            // ok | warn | crit
    detail: string;
}

interface IntegrityStatus {
    ts: string;
    overall: string;           // ok | warn | crit | init
    reference_mode: string;    // surveying | surveyed | configured
    fix_mode: number;
    uptime_s: number;
    checks: Record<string, IntegrityCheck>;
}

// Reads the daemon's status file and re-renders whenever it changes.
function useIntegrity(): { status: IntegrityStatus | null, missing: boolean } {
    const [status, setStatus] = useState<IntegrityStatus | null>(null);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
        const file = cockpit.file("/run/gps-integrity/status.json");
        file.watch((content: string | null) => {
            if (content === null) {
                setMissing(true);
                return;
            }
            try {
                setStatus(JSON.parse(content));
                setMissing(false);
            } catch { /* daemon mid-write; keep last good */ }
        });
        return () => file.close();
    }, []);

    return { status, missing };
}

/* ---- formatting helpers ---- */

const MODE_LABELS: Record<number, string> = { 0: _("Unknown"), 1: _("No fix"), 2: _("2D fix"), 3: _("3D fix") };

const GNSS_NAMES: Record<number, string> = {
    0: "GPS", 1: "SBAS", 2: "Galileo", 3: "BeiDou", 4: "IMES", 5: "QZSS", 6: "GLONASS", 7: "NavIC",
};

function fmtNum(v: number | undefined, digits: number, unit = ""): string {
    if (v === undefined || v === null || Number.isNaN(v))
        return "—";
    return v.toFixed(digits) + unit;
}

function toDMS(value: number, positive: string, negative: string): string {
    const hemi = value >= 0 ? positive : negative;
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const minFull = (abs - deg) * 60;
    const min = Math.floor(minFull);
    const sec = (minFull - min) * 60;
    return `${deg}° ${min}′ ${sec.toFixed(2)}″ ${hemi}`;
}

function cardinal(track: number | undefined): string {
    if (track === undefined)
        return "";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(track / 45) % 8];
}

function altitude(tpv: Tpv | null): number | undefined {
    if (!tpv)
        return undefined;
    return tpv.altMSL ?? tpv.alt ?? tpv.altHAE;
}

// Count of populated optional fields, used to pick the most-complete TPV of an
// epoch — gpsd emits several per second, sparsest (RMC-only) first.
function tpvScore(t: Tpv | null): number {
    if (!t)
        return -1;
    let n = 0;
    for (const v of [t.altMSL ?? t.alt, t.epx, t.epy, t.epv, t.climb, t.track])
        if (v !== undefined && v !== null)
            n++;
    return n;
}

// Satellites used in the navigation solution.
function usedCount(sky: Sky): number {
    return sky.uSat ?? (sky.satellites?.filter(s => s.used).length ?? 0);
}

// Satellites actually being received (non-zero SNR), excluding zero-signal
// almanac entries that pad gpsd's nSat.
function trackedCount(sky: Sky): number {
    return sky.satellites?.filter(s => (s.ss ?? 0) > 0).length ?? 0;
}

/* ---- small presentational helpers ---- */

const Row = ({ term, children }: { term: string, children: React.ReactNode }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

const FixLabel = ({ mode }: { mode?: number }) => {
    const m = mode ?? 0;
    const color = m >= 3 ? "green" : m === 2 ? "orange" : "red";
    return <Label color={color as "green" | "orange" | "red"}>{MODE_LABELS[m] ?? MODE_LABELS[0]}</Label>;
};

/* ---- cards ---- */

const PositionCard = ({ tpv }: { tpv: Tpv | null }) => {
    const hasFix = (tpv?.mode ?? 0) >= 2 && tpv?.lat !== undefined && tpv?.lon !== undefined;
    return (
        <Card>
            <CardTitle>{_("Position")}</CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    <Row term={_("Latitude")}>
                        {hasFix ? <>{fmtNum(tpv!.lat, 6, "°")}<div className="gps-sub">{toDMS(tpv!.lat!, "N", "S")}</div></> : "—"}
                    </Row>
                    <Row term={_("Longitude")}>
                        {hasFix ? <>{fmtNum(tpv!.lon, 6, "°")}<div className="gps-sub">{toDMS(tpv!.lon!, "E", "W")}</div></> : "—"}
                    </Row>
                    <Row term={_("Altitude")}>
                        {altitude(tpv) !== undefined
                            ? <>{fmtNum(altitude(tpv), 1, " m")}<span className="gps-sub"> ({fmtNum(altitude(tpv)! * 3.28084, 0, " ft")})</span></>
                            : "—"}
                    </Row>
                    <Row term={_("Est. error")}>
                        {tpv?.epx !== undefined || tpv?.epy !== undefined
                            ? `± ${fmtNum(Math.max(tpv?.epx ?? 0, tpv?.epy ?? 0), 1, " m")}`
                            : "—"}
                    </Row>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const MotionCard = ({ tpv }: { tpv: Tpv | null }) => {
    const speed = tpv?.speed;
    return (
        <Card>
            <CardTitle>{_("Motion")}</CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    <Row term={_("Speed")}>
                        {speed !== undefined
                            ? <>{fmtNum(speed * 1.94384, 1, " kn")}<span className="gps-sub"> ({fmtNum(speed * 3.6, 1, " km/h")})</span></>
                            : "—"}
                    </Row>
                    <Row term={_("Course")}>
                        {tpv?.track !== undefined ? `${fmtNum(tpv.track, 0, "°")} ${cardinal(tpv.track)}` : "—"}
                    </Row>
                    <Row term={_("Climb")}>{fmtNum(tpv?.climb, 2, " m/s")}</Row>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const QualityCard = ({ tpv, sky }: { tpv: Tpv | null, sky: Sky | null }) => {
    const time = tpv?.time ? new Date(tpv.time) : null;
    return (
        <Card>
            <CardTitle>{_("Fix quality")}</CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    <Row term={_("Fix")}><FixLabel mode={tpv?.mode} /></Row>
                    <Row term={_("Satellites")}>
                        {sky ? cockpit.format(_("$0 used / $1 with signal"), usedCount(sky), trackedCount(sky)) : "—"}
                    </Row>
                    <Row term="HDOP">{fmtNum(sky?.hdop, 2)}</Row>
                    <Row term="VDOP">{fmtNum(sky?.vdop, 2)}</Row>
                    <Row term={_("UTC time")}>{time ? time.toISOString().replace(".000", "") : "—"}</Row>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const SatelliteCard = ({ sky }: { sky: Sky | null }) => {
    // Show only satellites being tracked (have signal) or used in the fix; the
    // full list includes dozens of zero-signal almanac entries.
    const sats = (sky?.satellites ?? [])
            .filter(s => (s.ss ?? 0) > 0 || s.used)
            .sort((a, b) => (b.ss ?? -1) - (a.ss ?? -1));
    return (
        <Card>
            <CardTitle>{cockpit.format(_("Satellites — $0 tracked"), sats.length)}</CardTitle>
            <CardBody>
                {sats.length === 0
                    ? <span className="gps-sub">{_("No satellites tracked yet.")}</span>
                    : (
                        <table className="gps-sat-table">
                            <thead>
                                <tr>
                                    <th>{_("ID")}</th>
                                    <th>{_("System")}</th>
                                    <th>{_("Used")}</th>
                                    <th>{_("Elev")}</th>
                                    <th>{_("Azim")}</th>
                                    <th>{_("SNR (dB-Hz)")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sats.map((s, i) => (
                                    <tr key={i} className={s.used ? "gps-sat-used" : ""}>
                                        <td>{s.PRN ?? s.svid ?? "—"}</td>
                                        <td>{s.gnssid !== undefined ? (GNSS_NAMES[s.gnssid] ?? s.gnssid) : "—"}</td>
                                        <td>{s.used ? "✓" : ""}</td>
                                        <td>{fmtNum(s.el, 0, "°")}</td>
                                        <td>{fmtNum(s.az, 0, "°")}</td>
                                        <td>
                                            <div className="gps-snr">
                                                <span className="gps-snr-bar" style={{ width: `${Math.min(100, (s.ss ?? 0) * 2)}%` }} />
                                                <span className="gps-snr-val">{fmtNum(s.ss, 0)}</span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
            </CardBody>
        </Card>
    );
};

/* ---- integrity (spoof/jam) card ---- */

const SEV: Record<string, { color: "green" | "orange" | "red" | "blue", label: string }> = {
    ok: { color: "green", label: _("OK") },
    warn: { color: "orange", label: _("Warning") },
    crit: { color: "red", label: _("Critical") },
    init: { color: "blue", label: _("Starting") },
};

const CHECK_LABELS: Record<string, string> = {
    position: _("Position vs reference"),
    time: _("Time vs NTP"),
    velocity: _("Velocity"),
    cn0: _("C/N₀ profile"),
    jamming: _("Signal / jamming"),
    constellations: _("Constellations"),
};

const OVERALL_VARIANT: Record<string, "success" | "warning" | "danger" | "info"> = {
    ok: "success", warn: "warning", crit: "danger", init: "info",
};

const IntegrityCard = ({ status, missing }: { status: IntegrityStatus | null, missing: boolean }) => {
    let banner: React.ReactNode;
    if (missing && !status)
        banner = <Alert variant="info" isInline isPlain title={_("Integrity monitor not running (gps-integrity.service)")} />;
    else if (status) {
        const o = status.overall;
        const title = o === "ok" ? _("No spoofing or jamming indicators")
            : o === "init" ? cockpit.format(_("Surveying reference position…"))
                : o === "warn" ? _("Integrity warning — see checks below")
                    : _("Integrity ALERT — possible spoofing or jamming");
        banner = <Alert variant={OVERALL_VARIANT[o] ?? "info"} isInline isPlain title={title} />;
    }

    return (
        <Card>
            <CardTitle>{_("Integrity (spoof / jam)")}</CardTitle>
            <CardBody>
                {banner}
                {status && (
                    <table className="gps-integrity-table">
                        <tbody>
                            {Object.entries(status.checks).map(([key, c]) => (
                                <tr key={key}>
                                    <td>{CHECK_LABELS[key] ?? key}</td>
                                    <td><Label isCompact color={(SEV[c.status] ?? SEV.init).color}>{(SEV[c.status] ?? SEV.init).label}</Label></td>
                                    <td className="gps-sub">{c.detail}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {status && (
                    <div className="gps-sub" style={{ marginBlockStart: "8px" }}>
                        {cockpit.format(_("reference: $0 · updated $1"),
                            status.reference_mode,
                            status.ts ? new Date(status.ts).toLocaleTimeString() : "—")}
                    </div>
                )}
            </CardBody>
        </Card>
    );
};

/* ---- top-level status banner ---- */

const StatusBanner = ({ state }: { state: GpsdState }) => {
    if (state.error)
        return <Alert variant="danger" isInline title={_("GPS error")}>{state.error}</Alert>;
    if (!state.tpv && !state.sky)
        return <Alert variant="info" isInline title={_("Connecting to gpsd…")} />;
    const mode = state.tpv?.mode ?? 0;
    if (mode < 2)
        return <Alert variant="warning" isInline title={_("Acquiring satellites — no position fix yet")} />;
    return (
        <Alert
            variant="success"
            isInline
            title={cockpit.format(_("$0 — $1 satellites in use"), MODE_LABELS[mode], state.sky ? usedCount(state.sky) : 0)}
        />
    );
};

export const Application = () => {
    const state = useGpsd();
    const integrity = useIntegrity();

    return (
        <div className="gps-page">
            <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsLg" }}>
                <FlexItem>
                    <StatusBanner state={state} />
                </FlexItem>
                <FlexItem>
                    <Gallery hasGutter minWidths={{ default: "300px" }}>
                        <PositionCard tpv={state.tpv} />
                        <MotionCard tpv={state.tpv} />
                        <QualityCard tpv={state.tpv} sky={state.sky} />
                    </Gallery>
                </FlexItem>
                <FlexItem>
                    <IntegrityCard status={integrity.status} missing={integrity.missing} />
                </FlexItem>
                <FlexItem>
                    <SatelliteCard sky={state.sky} />
                </FlexItem>
            </Flex>
        </div>
    );
};
