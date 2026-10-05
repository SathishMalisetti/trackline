"""Interactive account sign-in only; never persist account passwords or tokens."""
from urllib.parse import urlparse
import requests


def sign_in(backend_url, email, password):
    backend_url = backend_url.strip().rstrip('/')
    parsed = urlparse(backend_url)
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
        raise ValueError('Use the HTTPS address of your Trackline app.')
    config_response = requests.get(f'{backend_url}/api/auth-config', timeout=15)
    config_response.raise_for_status()
    config = config_response.json()
    auth_url = config['url'].rstrip('/')
    if urlparse(auth_url).scheme != 'https':
        raise ValueError('The authentication service must use HTTPS.')
    response = requests.post(f'{auth_url}/auth/v1/token?grant_type=password',
                             headers={'apikey': config['publishableKey']},
                             json={'email': email.strip(), 'password': password}, timeout=15)
    if response.status_code != 200:
        raise ValueError('Account sign-in failed. Check your email/password and confirm your email.')
    token = response.json()['access_token']
    return {'Authorization': f'Bearer {token}'}


def verify_parent(backend_url, email, password, family_id):
    headers = sign_in(backend_url, email, password)
    response = requests.get(f'{backend_url.rstrip("/")}/api/auth-me', headers=headers, timeout=15)
    response.raise_for_status()
    if not any(m['family_id'] == family_id and m['role'] == 'parent' for m in response.json()['memberships']):
        raise ValueError('This account does not have parent access to this family.')
    return headers
