"""
AirChat Guardrails Classifier — Python sidecar service.

Runs Guardrails AI validators on gossip/shared channel messages.
Called by the Node.js classification pipeline as a Phase 2 enhancement.

POST /classify — classify a message, returns safety labels
GET /health — service health check
"""

from flask import Flask, request, jsonify
import time

from guardrails import Guard, OnFailAction
from guardrails.hub import ToxicLanguage, ProfanityFree, SecretsPresent

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024  # 64KB max request body

# Optional shared secret for sidecar auth (set GUARDRAILS_SECRET env var)
import os
SIDECAR_SECRET = os.environ.get('GUARDRAILS_SECRET', '')

MAX_CLASSIFY_TEXT = 8192  # Max chars sent to validators

# ── Build Guard chains ────────────────────────────────────────────────────────

# Separate guards per validator so we get individual results
guards = {}

guards['toxic_language'] = Guard(name='toxic').use(ToxicLanguage, on_fail=OnFailAction.NOOP)
guards['profanity'] = Guard(name='profanity').use(ProfanityFree, on_fail=OnFailAction.NOOP)
guards['secrets'] = Guard(name='secrets').use(SecretsPresent, on_fail=OnFailAction.NOOP)
# GibberishText disabled — too many false positives on technical content
# (our heuristic entropy detection is better tuned for developer messages)

# Try PII detector
HAS_PII = False
try:
    from guardrails.hub import DetectPII
    guards['pii'] = Guard(name='pii').use(DetectPII, on_fail=OnFailAction.NOOP)
    HAS_PII = True
    print("[guardrails] DetectPII loaded")
except Exception as e:
    print(f"[guardrails] DetectPII not available: {e}")

# Map validator names to AirChat safety labels
LABEL_MAP = {
    'toxic_language': 'toxic',
    'profanity': 'profanity',
    'secrets': 'contains-secrets',
    'pii': 'contains-pii',
}

# Validators that trigger quarantine (not just flagging)
QUARANTINE_VALIDATORS = {'secrets', 'pii'}


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'validators': list(guards.keys()),
        'validator_count': len(guards),
    })


@app.route('/classify', methods=['POST'])
def classify():
    """
    Classify a gossip message using Guardrails validators.

    Input:  { "content": "message text", "metadata": {...} }
    Output: {
        "labels": ["toxic", "contains-secrets", ...],
        "details": { "validator": { "passed": bool } },
        "quarantine": bool,
        "latency_ms": 123
    }
    """
    # Auth check (if GUARDRAILS_SECRET is set)
    if SIDECAR_SECRET:
        auth_header = request.headers.get('Authorization', '')
        if auth_header != f'Bearer {SIDECAR_SECRET}':
            return jsonify({'error': 'unauthorized'}), 401

    data = request.get_json()
    if not data or 'content' not in data:
        return jsonify({'error': 'content field required'}), 400

    content = data['content']

    # Flatten metadata into text for classification (capped to prevent huge inputs)
    meta_text = ''
    if data.get('metadata'):
        meta_text = ' '.join(str(v) for v in _flatten_values(data['metadata']))
        if len(meta_text) > 2048:
            meta_text = meta_text[:2048]

    text = f"{content} {meta_text}".strip()
    if len(text) > MAX_CLASSIFY_TEXT:
        text = text[:MAX_CLASSIFY_TEXT]

    start = time.time()
    labels = []
    details = {}
    quarantine = False

    # Run each validator independently
    for name, guard in guards.items():
        try:
            result = guard.validate(text)
            passed = result.validation_passed
            details[name] = {'passed': passed}

            if not passed:
                label = LABEL_MAP.get(name)
                if label:
                    labels.append(label)
                if name in QUARANTINE_VALIDATORS:
                    quarantine = True
        except Exception as e:
            details[name] = {'passed': True, 'error': str(e)[:100]}

    latency_ms = round((time.time() - start) * 1000, 1)

    if not labels:
        labels = ['clean']

    return jsonify({
        'labels': labels,
        'details': details,
        'quarantine': quarantine,
        'latency_ms': latency_ms,
    })


def _flatten_values(obj, depth=0):
    if depth > 10:
        return
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _flatten_values(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            yield from _flatten_values(v, depth + 1)


if __name__ == '__main__':
    print(f"[guardrails] Starting classifier with {len(guards)} validators: {list(guards.keys())}")
    print("[guardrails] Listening on http://127.0.0.1:8484")
    app.run(host='127.0.0.1', port=8484, debug=False)
