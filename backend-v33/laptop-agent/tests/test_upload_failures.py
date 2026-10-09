"""Isolated upload/retry units; no app startup, real network, pairing or DB calls."""
import ast
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from datetime import timezone
import requests

SOURCE = Path(__file__).resolve().parents[1] / 'trackline_agent.py'


def functions():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    selected = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                and n.name in ('push_snapshot', 'retry_unsent', 'sync_once')]
    scope = {'requests': Mock(RequestException=requests.RequestException),
             'mark_sent': Mock(), 'write_status': Mock(), 'print': Mock(),
             'timezone': timezone}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), scope)
    return scope


CFG = {'backend_url': 'https://example.invalid', 'device_id': 'test-device',
       'device_token': 'test-only', 'timezone': 'UTC'}
SNAPSHOT = {'date': '2026-10-09', 'hours': []}


class UploadFailureTests(unittest.TestCase):
    def test_network_errors_keep_snapshot_and_report_failure(self):
        for error in (requests.ConnectTimeout, requests.ReadTimeout,
                      requests.ConnectionError, requests.exceptions.SSLError):
            with self.subTest(error=error.__name__):
                s = functions()
                s['requests'].post.side_effect = error('simulated failure')
                self.assertEqual(s['push_snapshot'](CFG, SNAPSHOT, Path('audit.json')), 'failed')
                s['mark_sent'].assert_not_called()
                self.assertEqual(s['write_status'].call_args.args[0], 'failed')
                self.assertNotIn(CFG['device_token'], s['write_status'].call_args.args[1])

    def test_success_marks_sent(self):
        s = functions()
        s['requests'].post.return_value.status_code = 200
        self.assertEqual(s['push_snapshot'](CFG, SNAPSHOT, Path('audit.json')), 'ok')
        s['mark_sent'].assert_called_once_with(Path('audit.json'))

    def test_revocation_retains_existing_result(self):
        s = functions()
        s['requests'].post.return_value.status_code = 403
        self.assertEqual(s['push_snapshot'](CFG, SNAPSHOT, Path('audit.json')), 'revoked')
        s['mark_sent'].assert_not_called()

    def test_retry_stops_on_first_failure_without_removing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('first.json', 'second.json'):
                (root / name).write_text('{"date":"2026-10-09","hours":[]}', encoding='utf-8')
            s = functions()
            s.update(TRACKER_DIR=root, json=__import__('json'), push_snapshot=Mock(return_value='failed'))
            self.assertEqual(s['retry_unsent'](CFG), 'failed')
            s['push_snapshot'].assert_called_once()
            self.assertEqual(len(list(root.glob('*.json'))), 2)

    def test_scheduled_outside_window_skips_all_work(self):
        s = functions()
        s.update(load_config=Mock(return_value=CFG), upload_allowed=Mock(return_value=False),
                 read_status=Mock(), build_snapshot=Mock(), retry_unsent=Mock())
        self.assertEqual(s['sync_once'](scheduled=True), 'skipped')
        for name in ('read_status', 'build_snapshot', 'retry_unsent'):
            s[name].assert_not_called()

    def test_manual_sync_bypasses_window(self):
        s = functions()
        s.update(load_config=Mock(return_value=CFG), upload_allowed=Mock(return_value=False),
                 read_status=Mock(return_value=None), retry_unsent=Mock(return_value=None),
                 build_snapshot=Mock(return_value=SNAPSHOT), write_audit_file=Mock(return_value=Path('audit.json')),
                 push_snapshot=Mock(return_value='ok'))
        self.assertEqual(s['sync_once'](), 'ok')
        s['upload_allowed'].assert_not_called()
        s['push_snapshot'].assert_called_once()

    def test_offline_backlog_still_saves_current_snapshot(self):
        s = functions()
        s.update(load_config=Mock(return_value=CFG), read_status=Mock(return_value=None),
                 retry_unsent=Mock(return_value='failed'), build_snapshot=Mock(return_value=SNAPSHOT),
                 write_audit_file=Mock(return_value=Path('new.json')), push_snapshot=Mock())
        self.assertEqual(s['sync_once'](), 'failed')
        s['write_audit_file'].assert_called_once_with(SNAPSHOT)
        s['push_snapshot'].assert_not_called()


if __name__ == '__main__':
    unittest.main()
