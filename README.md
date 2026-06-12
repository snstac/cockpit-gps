# Cockpit GPS

A [Cockpit](https://cockpit-project.org/) plugin that shows live GNSS data from
**gpsd** — position, motion, fix quality, and a per-satellite signal table —
plus an optional **GPS spoof/jam integrity monitor**.

## Features

- **GPS page** in Cockpit's navigation: live position (decimal + DMS), altitude,
  speed/course, HDOP/VDOP, UTC time, and a satellite table with C/N₀ signal
  strength, sorted and filtered to satellites actually being tracked.
- **Stable readings.** gpsd emits several partial reports per second for chatty
  receivers; the UI coalesces them and updates once per second so values don't
  flip‑flop.
- **Receiver card** identifies the connected device — legacy NMEA, u-blox NMEA,
  or **u-blox UBX native** (ZED-F9P and friends) — with model, firmware, and
  capability badges.
- **Integrity card** (when the monitor is installed): an overall spoof/jam
  verdict plus per-check status — position‑vs‑reference, time‑vs‑NTP, velocity,
  C/N₀ profile, signal/jamming, constellation health, and (on UBX receivers)
  native **MON-RF** jamming telemetry.
- **RF monitor card** (u-blox UBX only): per-band jamming state, jamInd, and
  AGC from `UBX-MON-RF`, polled read-only through gpsd.
- **Backwards compatible** with any gpsd-backed receiver; legacy NMEA units get
  the full heuristic integrity suite with no UBX dependencies.

Built from the Cockpit
[starter-kit](https://github.com/cockpit-project/starter-kit)
(React + TypeScript + PatternFly, esbuild).

## Requirements

- `cockpit`
- `gpsd` and `gpsd-clients` (provides `gpspipe`), with a receiver configured
- `python3` (only for the optional integrity monitor)

```sh
# Debian/Ubuntu
sudo apt install cockpit gpsd gpsd-clients
# Fedora/RHEL
sudo dnf install cockpit gpsd gpsd-clients
```

## Install

### From source

```sh
git clone https://github.com/snstac/cockpit-gps.git
cd cockpit-gps
make                        # build into dist/ (fetches build helpers, runs npm install)
sudo make install           # -> /usr/share/cockpit/gps
sudo make install-integrity # optional spoof/jam monitor
sudo systemctl enable --now gps-integrity.service   # if you installed it
```

Or the convenience wrapper:

```sh
sudo ./install.sh --with-integrity     # system-wide, with the monitor
./install.sh --user                    # current user only, no root
```

Then open `https://<host>:9090` and click **GPS** (reload an open Cockpit tab to
pick up the new package).

### Packages (no build tools)

Download the `.deb` or `.rpm` for the latest release from the
[Releases](https://github.com/snstac/cockpit-gps/releases) page:

```sh
# Debian/Ubuntu
sudo apt install ./cockpit-gps_*_all.deb
# Fedora/RHEL
sudo dnf install ./cockpit-gps-*.noarch.rpm
```

The integrity monitor is included but not enabled by default:

```sh
sudo systemctl enable --now gps-integrity.service
```

### Development

```sh
make devel-install     # symlink dist/ into ~/.local/share/cockpit/gps
make watch             # rebuild on change; just reload the page
```

## Uninstall

```sh
sudo ./uninstall.sh        # or: ./uninstall.sh --user
```

## The integrity monitor

`gps-integrity` is a small Python daemon that reads gpsd and flags likely
spoofing/jamming with heuristics suited to a **fixed installation**:

| Check | Strong? | Catches |
|---|---|---|
| Position vs surveyed reference | ✅ | spoofer walking you off‑position |
| Time vs system/NTP clock | ✅ | spoofer dragging GPS time |
| Velocity while stationary | ✅ | spoofed motion |
| C/N₀ uniformity | ◐ | uniform‑high signals (spoof signature) |
| C/N₀ collapse + sat loss | ◐ | broadband jamming |
| Constellation drop | ◐ | GPS‑L1‑only spoofer |
| RF jamming (MON-RF) | ✅ | u-blox only — per-band jamInd + jammingState |

On **u-blox ZED-F9P** receivers with bidirectional UBX enabled, the monitor
auto-detects `driver=u-blox` + `native=1` from gpsd and polls `UBX-MON-RF`
read-only via `ubxtool` (no serial port contention). Legacy NMEA receivers
continue to use heuristic checks only.

It survey-ins a reference position on first run
(`/var/lib/gps-integrity/reference.json`), writes
`/run/gps-integrity/status.json` (read by the Cockpit card), and logs
`WARN`/`CRIT` transitions to the journal:

```sh
journalctl -u gps-integrity -f
```

Tuning is optional — copy `/etc/gps-integrity.conf.example` to
`/etc/gps-integrity.conf` and edit thresholds, set `stationary: false` for a
mobile install, or pin `ref_lat`/`ref_lon`/`ref_alt` to skip the survey.

**Limitations.** The strong detectors are position‑vs‑reference and
time‑vs‑NTP — both independent of the GNSS RF. On u-blox UBX receivers,
`UBX-MON-RF` jamming state is authoritative; heuristic C/N₀ checks remain as
a supplementary layer. Matched-power "meaconing" that holds position and time
can defeat all software-only detection.

**Field deployment.** Install `gpsd-tools` (provides `ubxtool`) on nodes with
ZED-F9P hardware. Configure the receiver with `zed-f9p-setup` (or equivalent)
so gpsd reports `driver=u-blox` and `native=1`. Set `stationary: false` in
`/etc/gps-integrity.conf` for mobile platforms.

#

## The snstac TAK sensor ecosystem

Different sensor, same workflow — pick the gateway for your application; most have a
matching Cockpit plugin for browser-based management:

| Application | Gateway | Cockpit plugin |
|---|---|---|
| Aircraft via ADS-B (1090 MHz / 978 MHz UAT) | [adsbcot](https://github.com/snstac/adsbcot) | [cockpit-adsbcot](https://github.com/snstac/cockpit-adsbcot) |
| Ships & vessels via AIS | [aiscot](https://github.com/snstac/aiscot) | [cockpit-aiscot](https://github.com/snstac/cockpit-aiscot), [cockpit-aiscatcher](https://github.com/snstac/cockpit-aiscatcher) |
| Drone / UAS Remote ID (counter-UAS) | [dronecot](https://github.com/snstac/dronecot) | [cockpit-dronecot](https://github.com/snstac/cockpit-dronecot) |
| Own position via GPS/GNSS | [lincot](https://github.com/snstac/lincot) | [cockpit-lincot](https://github.com/snstac/cockpit-lincot), [cockpit-gps](https://github.com/snstac/cockpit-gps) |
| Radio direction finding (KrakenSDR) | [kraktak](https://github.com/snstac/kraktak) | — |
| APRS amateur radio | [aprscot](https://github.com/snstac/aprscot) | — |
| Weather stations | [windtak](https://github.com/snstac/windtak) | — |
| CoT routing / TAK Server bridging | [charontak](https://github.com/snstac/charontak) | — |

All gateways are built on [PyTAK](https://github.com/snstac/pytak), speak
**Cursor on Target (CoT)** to **ATAK, WinTAK, iTAK, TAK Server, and Mesh SA**, ship as
signed Debian/RPM packages at [snstac.github.io/packages](https://snstac.github.io/packages),
and come pre-installed on [AryaOS](https://github.com/snstac/aryaos), the
situational-awareness OS for Raspberry Pi.


# License

Apache-2.0. See [LICENSE](LICENSE).
