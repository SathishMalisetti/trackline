"""Recovery unit checks: no real launches, ActivityWatch calls or uploads."""
import sys
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import activitywatch_recovery as recovery


class RecoveryTests(unittest.TestCase):
    def test_ready_does_not_launch(self):
        with patch.object(recovery, 'api_ready', return_value=True), patch.object(recovery.subprocess, 'Popen') as launch:
            recovery.ensure_activitywatch()
            launch.assert_not_called()

    def test_stopped_launches_once_and_waits(self):
        with patch.object(recovery.sys, 'platform', 'win32'), patch.object(recovery, 'api_ready', side_effect=[False, False, True]), patch.object(recovery, 'qt_running', return_value=False), patch.object(recovery, 'installed_executable', return_value=Path('C:/ActivityWatch/aw-qt.exe')), patch.object(recovery.subprocess, 'Popen') as launch, patch.object(recovery.time, 'sleep'):
            recovery.ensure_activitywatch()
            launch.assert_called_once()
            self.assertEqual(launch.call_args.args[0], [str(Path('C:/ActivityWatch/aw-qt.exe'))])
            self.assertEqual(launch.call_args.kwargs['cwd'], str(Path('C:/ActivityWatch')))

    def test_existing_qt_does_not_duplicate(self):
        with patch.object(recovery.sys, 'platform', 'win32'), patch.object(recovery, 'api_ready', side_effect=[False, True]), patch.object(recovery, 'qt_running', return_value=True), patch.object(recovery.subprocess, 'Popen') as launch:
            recovery.ensure_activitywatch()
            launch.assert_not_called()

    def test_missing_install_is_actionable(self):
        with patch.object(recovery.sys, 'platform', 'win32'), patch.object(recovery, 'api_ready', return_value=False), patch.object(recovery, 'qt_running', return_value=False), patch.object(recovery, 'installed_executable', return_value=None):
            with self.assertRaisesRegex(recovery.ActivityWatchUnavailable, 'not found'):
                recovery.ensure_activitywatch()

    def test_start_failure_is_handled(self):
        with patch.object(recovery.sys, 'platform', 'win32'), patch.object(recovery, 'api_ready', return_value=False), patch.object(recovery, 'qt_running', return_value=False), patch.object(recovery, 'installed_executable', return_value=Path('C:/ActivityWatch/aw-qt.exe')), patch.object(recovery.subprocess, 'Popen', side_effect=OSError('denied')):
            with self.assertRaisesRegex(recovery.ActivityWatchUnavailable, 'Could not start'):
                recovery.ensure_activitywatch()

    def test_startup_timeout_is_bounded(self):
        with patch.object(recovery.sys, 'platform', 'win32'), patch.object(recovery, 'api_ready', return_value=False), patch.object(recovery, 'qt_running', return_value=True):
            with self.assertRaisesRegex(recovery.ActivityWatchUnavailable, 'next scheduled sync'):
                recovery.ensure_activitywatch(wait_seconds=0)

    def test_health_requires_bucket_json_and_bypasses_proxy(self):
        with patch.object(recovery.requests, 'Session') as factory:
            session = factory.return_value.__enter__.return_value
            session.get.return_value.json.return_value = {}
            self.assertTrue(recovery.api_ready())
            self.assertFalse(session.trust_env)
            session.get.return_value.json.return_value = '<html>wrong service</html>'
            self.assertFalse(recovery.api_ready())


if __name__ == '__main__':
    unittest.main()
