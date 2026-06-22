/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cockpit GPS — live GNSS readout sourced from gpsd via `gpspipe -w`.
 * Supports legacy NMEA receivers and u-blox ZED-F9P (UBX native) alike.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Progress, ProgressSize } from "@patternfly/react-core/dist/esm/components/Progress/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

/* ---- gpsd JSON shapes ---- */

interface Device {
    class?: "DEVICE";
    path?: string;
    driver?: string;
    native?: number;
    readonly?: string | boolean;
    bps?: number;
    activated?: string;
}

interface Tpv {
    class: "TPV";
    mode?: number;
    lat?: number;
    lon?: number;
    altMSL?: number;
    altHAE?: number;
    alt?: number;
    speed?: number;
    track?: number;
    magtrack?: number;
    magvar?: number;
    climb?: number;
    time?: string;
    epx?: number;
    epy?: number;
    epv?: number;
    eph?: number;          // u-blox horizontal error (m)
    sep?: number;          // u-blox speed error (m/s)
    leapseconds?: number;
}

interface Attitude {
    class: "ATT" | "IMU";
    heading?: number;
    mheading?: number;
    mag_st?: string;
}

interface Sat {
    PRN?: number;
    gnssid?: number;
    svid?: number;
    sigid?: number;
    used?: boolean;
    el?: number;
    az?: number;
    ss?: number;
    qual?: number;         // u-blox signal quality indicator
    health?: number;
}

interface Sky {
    class: "SKY";
    satellites?: Sat[];
    hdop?: number;
    vdop?: number;
    pdop?: number;
    tdop?: number;
    uSat?: number;
    nSat?: number;
}

interface GpsdState {
    tpv: Tpv | null;
    sky: Sky | null;
    device: Device | null;
    attitude: Attitude | null;
    error: string | null;
    running: boolean;
}

interface IntegrityCheck {
    status: string;
    detail: string;
    source?: string;
}

interface RfBlock {
    block_id: number;
    band: string;
    noise_per_ms: number;
    agc_cnt: number;
    jam_ind: number;
    jamming_state: string;
    ant_status: string;
}

interface ReceiverInfo {
    tier: string;
    driver?: string;
    native?: boolean;
    path?: string;
    bps?: number;
    model?: string;
    firmware?: string;
    capabilities?: string[];
}

interface IntegrityStatus {
    ts: string;
    overall: string;
    reference_mode: string;
    fix_mode: number;
    uptime_s: number;
    receiver?: ReceiverInfo;
    rf?: { blocks: RfBlock[], ts: string };
    precision?: { eph_m?: number, sep_m?: number, epv_m?: number };
    checks: Record<string, IntegrityCheck>;
}

/* ---- streaming hook ---- */

function useGpsd(): GpsdState {
    const [tpv, setTpv] = useState<Tpv | null>(null);
    const [sky, setSky] = useState<Sky | null>(null);
    const [device, setDevice] = useState<Device | null>(null);
    const [attitude, setAttitude] = useState<Attitude | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const bestSky = useRef<Sky | null>(null);
    const bestTpv = useRef<Tpv | null>(null);
    const bestAttitude = useRef<Attitude | null>(null);

    useEffect(() => {
        let buffer = "";
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
                    const t = obj as unknown as Tpv;
                    if (tpvScore(t) >= tpvScore(bestTpv.current))
                        bestTpv.current = t;
                } else if (obj.class === "ATT" || obj.class === "IMU") {
                    bestAttitude.current = obj as unknown as Attitude;
                } else if (obj.class === "SKY") {
                    const s = obj as unknown as Sky;
                    const len = s.satellites?.length ?? 0;
                    if (len > 0 && len >= (bestSky.current?.satellites?.length ?? 0))
                        bestSky.current = s;
                } else if (obj.class === "DEVICE") {
                    setDevice(obj as unknown as Device);
                } else if (obj.class === "DEVICES") {
                    const devices = (obj as { devices?: Device[] }).devices;
                    if (devices?.[0])
                        setDevice(devices[0]);
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
            if (bestAttitude.current) {
                setAttitude(prev => ({ ...(prev ?? {}), ...bestAttitude.current! }));
                bestAttitude.current = null;
            }
        }, 1000);

        return () => {
            window.clearInterval(flush);
            try {
                proc.close("cancelled");
            } catch { /* already gone */ }
        };
    }, []);

    return { tpv, sky, device, attitude, error, running };
}

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
            } catch { /* daemon mid-write */ }
        });
        return () => file.close();
    }, []);

    return { status, missing };
}

/* ---- helpers ---- */

const MODE_LABELS: Record<number, string> = { 0: _("Unknown"), 1: _("No fix"), 2: _("2D fix"), 3: _("3D fix") };

const GNSS_NAMES: Record<number, string> = {
    0: "GPS", 1: "SBAS", 2: "Galileo", 3: "BeiDou", 4: "IMES", 5: "QZSS", 6: "GLONASS", 7: "NavIC",
};

const TIER_LABELS: Record<string, string> = {
    ubx: _("u-blox UBX"),
    enhanced: _("u-blox NMEA"),
    legacy: _("NMEA"),
    unknown: _("Unknown"),
};

const QUAL_LABELS: Record<number, string> = {
    0: "—", 1: _("search"), 2: _("acquired"), 3: _("unusable"),
    4: _("code"), 5: _("code+carrier"), 6: _("code+carrier"), 7: _("locked"),
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

function normalizeDegrees(value: number): number {
    return ((value % 360) + 360) % 360;
}

function fmtBearing(value: number | undefined): string {
    if (value === undefined || value === null || Number.isNaN(value))
        return "—";
    const bearing = normalizeDegrees(value);
    return `${fmtNum(bearing, 0, "°")} ${cardinal(bearing)}`;
}

function altitude(tpv: Tpv | null): number | undefined {
    if (!tpv)
        return undefined;
    return tpv.altMSL ?? tpv.alt ?? tpv.altHAE;
}

function tpvScore(t: Tpv | null): number {
    if (!t)
        return -1;
    let n = 0;
    for (const v of [t.altMSL ?? t.alt, t.epx, t.epy, t.epv, t.eph, t.climb, t.track, t.magvar])
        if (v !== undefined && v !== null)
            n++;
    return n;
}

function magneticCourse(tpv: Tpv | null): number | undefined {
    if (tpv?.magtrack !== undefined)
        return normalizeDegrees(tpv.magtrack);
    if (tpv?.track === undefined || tpv.magvar === undefined)
        return undefined;
    return normalizeDegrees(tpv.track + tpv.magvar);
}

function usedCount(sky: Sky): number {
    return sky.uSat ?? (sky.satellites?.filter(s => s.used).length ?? 0);
}

function trackedCount(sky: Sky): number {
    return sky.satellites?.filter(s => (s.ss ?? 0) > 0).length ?? 0;
}

function hasNativeUbx(device: Device | null): boolean {
    return device?.driver === "u-blox" && !!device?.native;
}

function horizontalError(tpv: Tpv | null): string {
    if (!tpv)
        return "—";
    if (tpv.eph !== undefined)
        return `± ${fmtNum(tpv.eph, 2, " m")}`;
    if (tpv.epx !== undefined || tpv.epy !== undefined)
        return `± ${fmtNum(Math.max(tpv.epx ?? 0, tpv.epy ?? 0), 1, " m")}`;
    return "—";
}

function receiverTier(device: Device | null): string {
    if (!device?.driver)
        return "unknown";
    if (device.driver === "u-blox" && device.native)
        return "ubx";
    if (device.driver === "u-blox")
        return "enhanced";
    return "legacy";
}

/* ---- presentational ---- */

const Row = ({ term, children }: { term: string, children: React.ReactNode }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

const FixLabel = ({ mode }: { mode?: number | undefined }) => {
    const m = mode ?? 0;
    const color = m >= 3 ? "green" : m === 2 ? "orange" : "red";
    return <Label color={color as "green" | "orange" | "red"}>{MODE_LABELS[m] ?? MODE_LABELS[0]}</Label>;
};

const ReceiverCard = ({ device, integrity }: { device: Device | null, integrity: IntegrityStatus | null }) => {
    const rx = integrity?.receiver;
    const tier = rx?.tier ?? receiverTier(device);
    const tierColor = tier === "ubx" ? "blue" : tier === "enhanced" ? "teal" : "grey";
    return (
        <Card>
            <CardTitle>{_("Receiver")}</CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    <Row term={_("Type")}>
                        <Label color={tierColor as "blue" | "teal" | "grey"}>{TIER_LABELS[tier] ?? tier}</Label>
                        {rx?.model && <span className="gps-sub" style={{ marginInlineStart: "8px" }}>{rx.model}</span>}
                    </Row>
                    <Row term={_("Driver")}>{device?.driver ?? rx?.driver ?? "—"}</Row>
                    {rx?.firmware && <Row term={_("Firmware")}>{rx.firmware}</Row>}
                    <Row term={_("Port")}>
                        <span className="gps-mono">{device?.path ?? rx?.path ?? "—"}</span>
                    </Row>
                    {(device?.bps ?? rx?.bps) && <Row term={_("Baud")}>{device?.bps ?? rx?.bps}</Row>}
                    {rx?.capabilities && rx.capabilities.length > 0 && (
                        <Row term={_("Capabilities")}>
                            <div className="gps-cap-badges">
                                {rx.capabilities.map(c => (
                                    <Label key={c} isCompact color="blue">{c}</Label>
                                ))}
                            </div>
                        </Row>
                    )}
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

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
                    <Row term={_("Est. error")}>{horizontalError(tpv)}</Row>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const MotionCard = ({ tpv, attitude }: { tpv: Tpv | null, attitude: Attitude | null }) => {
    const speed = tpv?.speed;
    const magneticHeading = attitude?.mheading;
    const derivedMagneticCourse = magneticCourse(tpv);
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
                        {fmtBearing(tpv?.track)}
                    </Row>
                    {(magneticHeading !== undefined || derivedMagneticCourse !== undefined) && (
                        <Row term={_("Magnetic heading")}>
                            {magneticHeading !== undefined
                                ? (
                                    <>
                                        {fmtBearing(magneticHeading)}
                                        {attitude?.mag_st && <span className="gps-sub"> ({attitude.mag_st})</span>}
                                    </>
                                )
                                : (
                                    <>
                                        {fmtBearing(derivedMagneticCourse)}
                                        <span className="gps-sub"> {_("derived from course")}</span>
                                    </>
                                )}
                        </Row>
                    )}
                    {tpv?.magvar !== undefined && (
                        <Row term={_("Mag. variation")}>{fmtNum(tpv.magvar, 1, "°")}</Row>
                    )}
                    <Row term={_("Climb")}>{fmtNum(tpv?.climb, 2, " m/s")}</Row>
                    {tpv?.sep !== undefined && <Row term={_("Speed error")}>{fmtNum(tpv.sep, 2, " m/s")}</Row>}
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
                    {sky?.pdop !== undefined && <Row term="PDOP">{fmtNum(sky.pdop, 2)}</Row>}
                    {tpv?.eph !== undefined && <Row term={_("H. precision")}>{fmtNum(tpv.eph, 2, " m")}</Row>}
                    {tpv?.epv !== undefined && <Row term={_("V. precision")}>{fmtNum(tpv.epv, 2, " m")}</Row>}
                    {tpv?.leapseconds !== undefined && <Row term={_("Leap sec")}>{tpv.leapseconds}</Row>}
                    <Row term={_("UTC time")}>{time ? time.toISOString().replace(".000", "") : "—"}</Row>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const RfMonitorCard = ({ rf }: { rf: IntegrityStatus["rf"] }) => {
    if (!rf?.blocks?.length)
        return null;
    const jamColor = (state: string) => state === "OK" ? "green" : state === "Warning" ? "orange" : "red";
    return (
        <Card>
            <CardTitle>{_("RF monitor (u-blox MON-RF)")}</CardTitle>
            <CardBody>
                <table className="gps-rf-table">
                    <thead>
                        <tr>
                            <th>{_("Band")}</th>
                            <th>{_("Jamming")}</th>
                            <th>{_("jamInd")}</th>
                            <th>{_("AGC")}</th>
                            <th>{_("Antenna")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rf.blocks.map(b => (
                            <tr key={b.block_id}>
                                <td>{b.band}</td>
                                <td><Label isCompact color={jamColor(b.jamming_state) as "green" | "orange" | "red"}>{b.jamming_state}</Label></td>
                                <td>
                                    <Progress value={b.jam_ind} title={String(b.jam_ind)} size={ProgressSize.sm} />
                                </td>
                                <td>{b.agc_cnt}</td>
                                <td>{b.ant_status}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div className="gps-sub" style={{ marginBlockStart: "8px" }}>
                    {cockpit.format(_("Updated $0"), rf.ts ?? "—")}
                </div>
            </CardBody>
        </Card>
    );
};

const SatelliteCard = ({ sky, native }: { sky: Sky | null, native: boolean }) => {
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
                                    {native && <th>{_("Qual")}</th>}
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
                                        {native && <td className="gps-sub">{s.qual !== undefined ? (QUAL_LABELS[s.qual] ?? s.qual) : "—"}</td>}
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
    jamming: _("Signal / jamming (heuristic)"),
    rf_jamming: _("RF jamming (MON-RF)"),
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
            : o === "init" ? _("Surveying reference position…")
                : o === "warn" ? _("Integrity warning — see checks below")
                    : _("Integrity ALERT — possible spoofing or jamming");
        banner = <Alert variant={OVERALL_VARIANT[o] ?? "info"} isInline isPlain title={title} />;
    }

    const checks = status?.checks ?? {};
    const order = ["rf_jamming", "position", "time", "velocity", "cn0", "jamming", "constellations"];
    const sorted = Object.entries(checks).sort(([a], [b]) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    return (
        <Card>
            <CardTitle>{_("Integrity (spoof / jam)")}</CardTitle>
            <CardBody>
                {banner}
                {status && (
                    <table className="gps-integrity-table">
                        <tbody>
                            {sorted.map(([key, c]) => (
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

const StatusBanner = ({ state }: { state: GpsdState }) => {
    if (state.error)
        return <Alert variant="danger" isInline title={_("GPS error")}>{state.error}</Alert>;
    if (!state.tpv && !state.sky)
        return <Alert variant="info" isInline title={_("Connecting to gpsd…")} />;
    const mode = state.tpv?.mode ?? 0;
    const tier = receiverTier(state.device);
    const tierNote = tier === "ubx" ? _(" · ZED-F9P UBX") : tier === "legacy" ? "" : _(" · u-blox");
    if (mode < 2)
        return <Alert variant="warning" isInline title={_("Acquiring satellites — no position fix yet")} />;
    const prec = state.tpv?.eph !== undefined ? cockpit.format(_(", ±$0 m"), fmtNum(state.tpv.eph, 2)) : "";
    return (
        <Alert
            variant="success"
            isInline
            title={cockpit.format(_("$0 — $1 satellites in use$2$3"),
                MODE_LABELS[mode],
                state.sky ? usedCount(state.sky) : 0,
                prec,
                tierNote)}
        />
    );
};

export const Application = () => {
    const state = useGpsd();
    const integrity = useIntegrity();
    const native = hasNativeUbx(state.device);

    return (
        <div className="gps-page">
            <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsLg" }}>
                <FlexItem>
                    <StatusBanner state={state} />
                </FlexItem>
                <FlexItem>
                    <Gallery hasGutter minWidths={{ default: "280px" }}>
                        <ReceiverCard device={state.device} integrity={integrity.status} />
                        <PositionCard tpv={state.tpv} />
                        <MotionCard tpv={state.tpv} attitude={state.attitude} />
                        <QualityCard tpv={state.tpv} sky={state.sky} />
                    </Gallery>
                </FlexItem>
                <FlexItem>
                    <IntegrityCard status={integrity.status} missing={integrity.missing} />
                </FlexItem>
                {integrity.status?.rf && (
                    <FlexItem>
                        <RfMonitorCard rf={integrity.status.rf} />
                    </FlexItem>
                )}
                <FlexItem>
                    <SatelliteCard sky={state.sky} native={native} />
                </FlexItem>
            </Flex>
        </div>
    );
};
