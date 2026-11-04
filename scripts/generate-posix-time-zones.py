#!/usr/bin/env python3
"""Writes lambda/controllers/posix-time-zones.json from the IANA time zone data.

The last line of a compiled time zone file is the zone's current rule as a POSIX
TZ string, which is what the controller needs. Run again when a country changes
its rules:

    pip install --upgrade tzdata
    python scripts/generate-posix-time-zones.py
"""
import json
import pathlib
import re

import tzdata

# What the firmware accepts (MQTT contract, section 4).
VALID = re.compile(r"^[A-Za-z<][A-Za-z0-9+\-,.:/<>]{0,62}$")

ZONEINFO = pathlib.Path(tzdata.__file__).parent / "zoneinfo"
TARGET = pathlib.Path(__file__).parent.parent / "lambda" / "controllers" / "posix-time-zones.json"


def posix_rule(path: pathlib.Path) -> str | None:
    content = path.read_bytes()
    if not content.startswith(b"TZif"):
        return None
    return content.rstrip(b"\n").rsplit(b"\n", 1)[-1].decode("ascii")


def main() -> None:
    zones = {}
    for path in sorted(ZONEINFO.rglob("*")):
        rule = posix_rule(path) if path.is_file() else None
        if rule is None:
            continue
        name = path.relative_to(ZONEINFO).as_posix()
        if not VALID.match(rule):
            raise SystemExit(f"{name} has a rule the controller refuses: {rule!r}")
        zones[name] = rule

    TARGET.write_text(
        json.dumps({"tzdata": tzdata.IANA_VERSION, "zones": zones}, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"{len(zones)} zones from tzdata {tzdata.IANA_VERSION}")


if __name__ == "__main__":
    main()
