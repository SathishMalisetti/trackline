"""Automatic upload window, evaluated against the laptop local clock."""
from datetime import datetime
import re


def parse_clock(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise ValueError("Enter times as HH:MM in 24-hour format (for example 16:00 and 22:00).")
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def validate_window(start, end):
    if parse_clock(start) == parse_clock(end):
        raise ValueError("Start and end must differ. Turn off the window for all-day uploads.")


def upload_allowed(cfg, now=None):
    window = cfg.get("upload_window") or {}
    if not window.get("enabled", False):
        return True
    start, end = window.get("start"), window.get("end")
    validate_window(start, end)
    start, end = parse_clock(start), parse_clock(end)
    now = now or datetime.now().astimezone()
    minute = now.hour * 60 + now.minute
    # Start inclusive, end exclusive; overnight windows cross midnight.
    return start <= minute < end if start < end else minute >= start or minute < end
