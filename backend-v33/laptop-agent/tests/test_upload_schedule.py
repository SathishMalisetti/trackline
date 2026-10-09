import sys
import unittest
from datetime import datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from upload_schedule import upload_allowed, validate_window


class UploadScheduleTests(unittest.TestCase):
    def test_existing_configs_upload_all_day(self):
        self.assertTrue(upload_allowed({}, datetime(2026, 1, 1, 2)))

    def test_daily_boundaries(self):
        cfg = {'upload_window': {'enabled': True, 'start': '16:00', 'end': '22:00'}}
        for hour, minute, expected in [(15,59,False), (16,0,True), (21,59,True), (22,0,False)]:
            with self.subTest(hour=hour, minute=minute):
                self.assertEqual(upload_allowed(cfg, datetime(2026,1,1,hour,minute)), expected)

    def test_overnight(self):
        cfg = {'upload_window': {'enabled': True, 'start': '22:00', 'end': '04:00'}}
        for hour, expected in [(23,True),(0,True),(3,True),(4,False),(12,False)]:
            self.assertEqual(upload_allowed(cfg, datetime(2026,1,1,hour)), expected)

    def test_invalid_values(self):
        for start, end in [('4 PM','22:00'), ('24:00','22:00'), ('16:60','22:00'), ('16:00','16:00')]:
            with self.subTest(start=start,end=end), self.assertRaises(ValueError):
                validate_window(start,end)

    def test_disabled_ignores_stale_fields(self):
        self.assertTrue(upload_allowed({'upload_window': {'enabled':False,'start':'bad'}}))
