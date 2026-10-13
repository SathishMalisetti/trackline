import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_auth import family_post, verify_family
from trackline_setup_gui import pair_device
from trackline_config_manager import verify_family_password


class FamilyAccessTests(unittest.TestCase):
    def session(self, status=200, result=None):
        session = MagicMock()
        login = MagicMock(status_code=status)
        login.json.return_value = result or {'familyId': 'FAMILY1'}
        session.post.side_effect = [login, MagicMock(status_code=200)]
        return session

    def test_pair_uses_only_family_login_and_cleans_session(self):
        session = self.session()
        with patch('account_auth.requests.Session', return_value=session):
            family_post('https://app.example/', ' family1 ', 'family-secret', 'device-pair', {'memberId': 'kid1'})
        login = session.post.call_args_list[0]
        self.assertEqual(login.kwargs['json'], {'action': 'login', 'identity': 'FAMILY1', 'password': 'family-secret'})
        self.assertEqual(session.post.call_args_list[1].args[0], 'https://app.example/api/device-pair')
        session.delete.assert_called_once()
        session.close.assert_called_once()

    def test_wrong_password_never_pairs(self):
        session = self.session(403, {'error': 'Incorrect family password.'})
        with patch('account_auth.requests.Session', return_value=session), self.assertRaisesRegex(ValueError, 'Incorrect family password'):
            family_post('https://app.example', 'FAMILY1', 'wrong', 'device-pair', {})
        self.assertEqual(session.post.call_count, 1)
        session.delete.assert_not_called()
        session.close.assert_called_once()

    def test_username_is_not_accepted_in_place_of_family_id(self):
        session = self.session()
        with patch('account_auth.requests.Session', return_value=session), self.assertRaisesRegex(ValueError, 'Family ID'):
            verify_family('https://app.example', 'username', 'secret')
        session.delete.assert_called_once()

    def test_config_changes_work_without_old_email_field(self):
        with patch('trackline_config_manager.verify_family', return_value=True) as verify:
            self.assertEqual(verify_family_password({'backend_url': 'https://app.example', 'family_id': 'FAMILY1'}, 'secret'), (True, ''))
            verify.assert_called_once_with('https://app.example', 'FAMILY1', 'secret')

    def test_pair_config_does_not_persist_family_credentials(self):
        def post(url, json):
            return {'status': 200, 'json': {'deviceId': 'dev1', 'deviceToken': 'device-secret'}}
        ok, config = pair_device('https://app.example', 'FAMILY1', 'family-secret', 'kid1', 'Kid', 'Laptop', 'host', 'Australia/Sydney', post)
        self.assertTrue(ok)
        self.assertNotIn('family-secret', str(config))
        self.assertNotIn('account_email', config)
        self.assertEqual(config['device_token'], 'device-secret')

    def test_remote_http_is_rejected_before_credentials_are_sent(self):
        with patch('account_auth.requests.Session') as session, self.assertRaisesRegex(ValueError, 'HTTPS'):
            verify_family('http://remote.example', 'FAMILY1', 'secret')
        session.assert_not_called()


if __name__ == '__main__':
    unittest.main()
