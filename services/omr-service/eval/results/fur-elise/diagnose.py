#!/usr/bin/env python3
"""ScoreData vs Mutopia MIDI diagnostics for Für Elise. Not production code."""

from __future__ import annotations

import json
import struct
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCORE_PATH = Path(__file__).resolve().parent / "score.json"
MIDI_PATH = ROOT / "cache/downloads/fur-elise-midi/fur-elise.mid"
OUT_MIDI = Path(__file__).resolve().parent / "omr-from-scoredata.mid"
OUT_DIAG = Path(__file__).resolve().parent / "diagnostics.json"

TPQ_SCORE = 480
BAR_3_8 = 720  # 3 eighths at 480
SIXTEENTH = 120
HUMANIZE_TICKS_AT_96 = 10  # ~12 ms at 96 bpm ≈ 9.2 ticks; pad to 10


def vlq(n: int) -> bytes:
    parts = [n & 0x7F]
    n >>= 7
    while n:
        parts.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(parts))


def write_midi(notes: list[dict], path: Path, bpm: float) -> None:
    us = int(round(60_000_000 / bpm))
    events: list[tuple[int, bytes]] = []
    tempo = bytes([0xFF, 0x51, 0x03, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF])
    events.append((0, tempo))
    events.append((0, bytes([0xFF, 0x58, 0x04, 3, 3, 24, 8])))  # 3/8
    for n in notes:
        vel = max(1, min(127, int(round((n.get("v") or 0.75) * 127))))
        ch = 0 if n["h"] == 0 else 1
        events.append((n["t"], bytes([0x90 | ch, n["p"], vel])))
        events.append((n["t"] + n["d"], bytes([0x80 | ch, n["p"], 0])))
    events.sort(key=lambda e: (e[0], 0 if e[1][0] & 0xF0 == 0x80 else 1))
    body = bytearray()
    last = 0
    for tick, payload in events:
        body += vlq(max(0, tick - last))
        body += payload
        last = tick
    body += vlq(0) + bytes([0xFF, 0x2F, 0x00])
    track = b"MTrk" + struct.pack(">I", len(body)) + body
    header = b"MThd" + struct.pack(">IHHH", 6, 1, 1, TPQ_SCORE)
    path.write_bytes(header + track)


def read_vlq(buf: bytes, i: int) -> tuple[int, int]:
    v = 0
    for _ in range(5):
        b = buf[i]
        i += 1
        v = (v << 7) | (b & 0x7F)
        if b < 0x80:
            return v, i
    raise ValueError("vlq")


def parse_smf(path: Path) -> dict:
    data = path.read_bytes()
    ntrks = struct.unpack(">H", data[10:12])[0]
    tpq = struct.unpack(">H", data[12:14])[0]
    i = 14
    tempos = []
    notes = []
    for _ in range(ntrks):
        ln = struct.unpack(">I", data[i + 4 : i + 8])[0]
        i += 8
        end = i + ln
        tick = 0
        running = 0
        pending: dict[int, list[int]] = {}
        while i < end:
            delta, i = read_vlq(data, i)
            tick += delta
            first = data[i]
            i += 1
            if first == 0xFF:
                typ = data[i]
                i += 1
                ln2, i = read_vlq(data, i)
                payload = data[i : i + ln2]
                i += ln2
                if typ == 0x2F:
                    break
                if typ == 0x51 and ln2 == 3:
                    us = (payload[0] << 16) | (payload[1] << 8) | payload[2]
                    tempos.append({"tick": tick, "bpm": round(60_000_000 / us, 3)})
                continue
            if first in (0xF0, 0xF7):
                ln2, i = read_vlq(data, i)
                i += ln2
                continue
            if first < 0x80:
                status = running
                data1 = first
            else:
                running = first if first < 0xF0 else 0
                status = first
                data1 = data[i]
                i += 1
            cmd = status & 0xF0
            if cmd in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                data2 = data[i]
                i += 1
            else:
                data2 = 0
            if cmd == 0x90:
                if data2:
                    pending.setdefault(data1, []).append(tick)
                else:
                    ons = pending.get(data1)
                    if ons:
                        on = ons.pop(0)
                        notes.append({"t": on, "d": tick - on, "p": data1})
            elif cmd == 0x80:
                ons = pending.get(data1)
                if ons:
                    on = ons.pop(0)
                    notes.append({"t": on, "d": tick - on, "p": data1})
        i = end
    return {"tpq": tpq, "tempos": tempos, "notes": notes, "maxTick": max((n["t"] + n["d"] for n in notes), default=0)}


def main() -> None:
    score = json.loads(SCORE_PATH.read_text())
    notes = score["notes"]
    measures = score["measures"]
    pages = sorted({m["page"] for m in measures})
    sys_pages = sorted({s["page"] for s in score["systems"]})
    expected = BAR_3_8
    overfull = []
    underfull = []
    empty = []
    silence = []
    geom_missing = []
    for m in measures:
        members = [n for n in notes if m["tick"] <= n["t"] < m["tick"] + m["dTicks"]]
        if m["dTicks"] > expected + 30:
            overfull.append({"n": m["n"], "page": m["page"], "dTicks": m["dTicks"], "over": m["dTicks"] - expected, "notes": len(members)})
        elif m["dTicks"] < expected - 30 and not (m["n"] == 1 and m["dTicks"] <= 240 + 30):
            underfull.append({"n": m["n"], "page": m["page"], "dTicks": m["dTicks"], "short": expected - m["dTicks"], "notes": len(members)})
        if not members:
            empty.append({"n": m["n"], "page": m["page"], "dTicks": m["dTicks"], "tick": m["tick"]})
        else:
            last = max(n["t"] + n["d"] for n in members)
            gap = m["tick"] + m["dTicks"] - last
            if gap >= SIXTEENTH:
                silence.append({"n": m["n"], "page": m["page"], "gapTicks": gap, "notes": len(members)})
        if m["page"] < 0 or m["sys"] < 0:
            geom_missing.append({"n": m["n"], "page": m["page"], "sys": m["sys"], "dTicks": m["dTicks"]})

    # Chord stagger: notes in the same hand within a 16th that are not unison-onset.
    by_t: dict[int, list] = defaultdict(list)
    for n in notes:
        by_t[n["t"]].append(n)
    same_onset_chords = sum(1 for g in by_t.values() if len(g) >= 2)
    stagger = []
    def measure_n_at(tick: int) -> int | None:
        for mm in measures:
            if mm["tick"] <= tick < mm["tick"] + mm["dTicks"]:
                return mm["n"]
        return None

    for i, n in enumerate(notes):
        for other in notes[i + 1 : i + 24]:
            dt = other["t"] - n["t"]
            if dt <= 0:
                continue
            if dt > SIXTEENTH:
                break
            if n["h"] != other["h"]:
                continue
            if dt <= HUMANIZE_TICKS_AT_96:
                continue
            if abs(n["p"] - other["p"]) > 0 and dt < 80:
                stagger.append(
                    {
                        "t": n["t"],
                        "dt": dt,
                        "p": [n["p"], other["p"]],
                        "h": n["h"],
                        "measure": measure_n_at(n["t"]),
                    }
                )
    # Dedup clusters: keep first 40 examples
    seen = set()
    stagger_uniq = []
    for s in stagger:
        key = (s["t"], s["h"])
        if key in seen:
            continue
        seen.add(key)
        stagger_uniq.append(s)

    # Intra-piece bpm: tempos missing
    bpm_jumps = []
    tempos = score.get("tempos") or []
    prev = score.get("defaultBpm")
    for t in tempos:
        if prev is not None and abs(t["bpm"] - prev) >= 8:
            bpm_jumps.append({"tick": t["tick"], "from": prev, "to": t["bpm"], "src": t.get("src")})
        prev = t["bpm"]

    rh = sum(1 for n in notes if n["h"] == 0)
    lh = sum(1 for n in notes if n["h"] == 1)
    d_hist = Counter(m["dTicks"] for m in measures)

    midi = parse_smf(MIDI_PATH)
    write_midi(notes, OUT_MIDI, score.get("defaultBpm") or 96)

    extra_ticks = sum(m["dTicks"] for m in measures) - (len(measures) * expected)
    pickup_like = [m for m in measures if m["dTicks"] <= 270]
    diag = {
        "piece": "Beethoven — Für Elise, WoO 59",
        "engine": "from score.json",
        "coverage": {
            "notes": len(notes),
            "rh": rh,
            "lh": lh,
            "measures": len(measures),
            "systems": len(score["systems"]),
            "pagesInMeasures": pages,
            "pagesInSystems": sys_pages,
            "totalTicks": score["totalTicks"],
            "totalTicksQuarters": score["totalTicks"] / TPQ_SCORE,
            "midiQuarters": midi["maxTick"] / midi["tpq"],
            "keySignatures": score.get("keySignatures"),
            "tempos": tempos,
            "defaultBpm": score.get("defaultBpm"),
            "timeSignatures": score.get("timeSignatures"),
            "warnings": score.get("warnings"),
            "holds": score.get("holds"),
            "clefs": score.get("clefs"),
        },
        "measureLengths": {
            "expected3_8": expected,
            "dTicksHistogram": dict(sorted(d_hist.items())),
            "overfullCount": len(overfull),
            "underfullCount": len(underfull),
            "emptyCount": len(empty),
            "geomMissingCount": len(geom_missing),
            "silenceAfterLastNoteCount": len(silence),
            "overfull": overfull[:25],
            "underfull": underfull[:25],
            "empty": empty[:25],
            "geomMissing": geom_missing[:25],
            "silenceWorst": sorted(silence, key=lambda x: -x["gapTicks"])[:20],
            "extraTicksVsIdealBars": extra_ticks,
            "pickupLike": pickup_like[:8],
        },
        "tempo": {
            "defaultBpm": score.get("defaultBpm"),
            "tempo_defaulted": "tempo_defaulted" in (score.get("warnings") or []),
            "omrTempos": tempos,
            "midiTemposQuarterBpm": midi["tempos"],
            "expectedMutopiaQuarterBpm": 72,
            "bpmJumpsGte8": bpm_jumps,
        },
        "chords": {
            "sameOnsetGroups": same_onset_chords,
            "staggerClustersDt11to79": len(stagger_uniq),
            "staggerExamples": stagger_uniq[:25],
            "engineHumanizeTicksAt96bpm": HUMANIZE_TICKS_AT_96,
        },
        "seams": {
            "pages_skipped": "pages_skipped" in (score.get("warnings") or []),
            "parts_concatenated": "parts_concatenated" in (score.get("warnings") or []),
            "multi_part_collapsed": "multi_part_collapsed" in (score.get("warnings") or []),
            "pageCount": 3,
            "parallelShardMinPages": 4,
        },
        "midiRef": {
            "notes": len(midi["notes"]),
            "tpq": midi["tpq"],
            "maxTick": midi["maxTick"],
        },
        "exportedMidi": str(OUT_MIDI),
    }
    OUT_DIAG.write_text(json.dumps(diag, indent=2) + "\n")
    print(json.dumps({k: diag[k] if k not in ("measureLengths", "chords") else {kk: v for kk, v in diag[k].items() if not kk.endswith("amples") and kk not in ("overfull", "underfull", "empty", "geomMissing", "silenceWorst", "staggerExamples")} for k in diag if k != "coverage"} | {"coverageKeys": list(diag["coverage"].keys()), "notes": diag["coverage"]["notes"], "measures": diag["coverage"]["measures"], "overfull": diag["measureLengths"]["overfullCount"], "empty": diag["measureLengths"]["emptyCount"], "stagger": diag["chords"]["staggerClustersDt11to79"]}, indent=2))


if __name__ == "__main__":
    main()
