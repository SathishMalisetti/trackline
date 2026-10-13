"""Short-lived family access for installer actions; never save credentials."""
from contextlib import contextmanager
from urllib.parse import urlparse
import requests


@contextmanager
def family_session(backend_url, family_id, password):
    backend_url = backend_url.strip().rstrip('/')
    parsed = urlparse(backend_url)
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
        raise ValueError('Use the HTTPS address of your Trackline app.')
    family_id = family_id.strip().upper()
    if not family_id or not password:
        raise ValueError('Enter your Family ID and family password.')
    session = requests.Session()
    signed_in = False
    try:
        response = session.post(f'{backend_url}/api/family-session', json={
            'action': 'login', 'identity': family_id, 'password': password,
        }, timeout=15, allow_redirects=False)
        result = response.json()
        if response.status_code != 200:
            raise ValueError(result.get('error', 'Incorrect Family ID or family password.'))
        signed_in = True
        if result.get('familyId') != family_id:
            raise ValueError('Enter the Family ID, not a username.')
        session.headers.update({'X-Trackline-Session': 'family'})
        # The API cookie is Secure; permit explicit loopback development only.
        if parsed.scheme == 'http':
            token = session.cookies.get('__Host-trackline-family')
            if token:
                session.headers.update({'Cookie': f'__Host-trackline-family={token}'})
        yield session
    finally:
        if signed_in:
            try:
                session.delete(f'{backend_url}/api/family-session', timeout=15, allow_redirects=False)
            except requests.RequestException:
                pass  # The server-side temporary session expires normally.
        session.close()


def family_post(backend_url, family_id, password, endpoint, payload):
    if endpoint not in ('family-members', 'device-pair'):
        raise ValueError('Unsupported installer action.')
    backend_url = backend_url.strip().rstrip('/')
    with family_session(backend_url, family_id, password) as session:
        return session.post(f'{backend_url}/api/{endpoint}', json=payload,
                            timeout=15, allow_redirects=False)


def verify_family(backend_url, family_id, password):
    with family_session(backend_url, family_id, password):
        return True
