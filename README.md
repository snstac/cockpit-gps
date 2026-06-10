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
- **Integrity card** (when the monitor is installed): an overall spoof/jam
  verdict plus per-check status — position‑vs‑reference, time‑vs‑NTP, velocity,
  C/N₀ profile, signal/jamming, and constellation health.

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

### Prebuilt (no build tools)

Grab `cockpit-gps.tar.gz` from the
[Releases](https://github.com/snstac/cockpit-gps/releases) page, then:

```sh
tar xzf cockpit-gps.tar.gz && cd cockpit-gps
sudo ./install.sh --with-integrity
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
time‑vs‑NTP — both independent of the GNSS RF. The C/N₀/jamming checks are
proxies for the receiver's AGC data, which on a u-blox is only exposed over UBX
(`UBX-NAV-STATUS`, `UBX-SEC-SIG`, `UBX-MON-RF`); if your receiver speaks UBX to
gpsd, those are the authoritative source. Matched-power "meaconing" that holds
position and time can defeat heuristic detection.

## License

Apache-2.0. See [LICENSE](LICENSE).
