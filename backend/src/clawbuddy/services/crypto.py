"""AES-256-GCM encryption service — wire-compatible with the Node.js implementation.

Replaces: apps/api/src/services/crypto.service.ts

Format: ``iv_b64:tag_b64:ciphertext_b64`` (colon-separated base64 strings).
Uses scrypt key derivation with the same salt to produce an identical 32-byte key.
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from clawbuddy.settings import settings

_ALGORITHM = "aes-256-gcm"
_IV_LENGTH = 12  # 96-bit nonce
_TAG_LENGTH = 16  # 128-bit auth tag

# Derive key once at import time using scrypt — same parameters as Node.js crypto.scryptSync
_SALT = (settings.ENCRYPTION_SALT or "clawbuddy-api-key-encryption").encode("utf-8")
_KEY = hashlib.scrypt(
    settings.ENCRYPTION_SECRET.encode("utf-8"),
    salt=_SALT,
    n=16384,  # Node.js default cost factor (2^14)
    r=8,
    p=1,
    dklen=32,
)

_aesgcm = AESGCM(_KEY)


def encrypt(plaintext: str) -> str:
    """Encrypt *plaintext* and return the ``iv:tag:data`` base64 string.

    Wire-compatible with the TypeScript ``encrypt()`` function.
    """
    iv = os.urandom(_IV_LENGTH)
    # AESGCM.encrypt returns ciphertext || tag (tag appended)
    ct_with_tag = _aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)

    # Split ciphertext and tag (last 16 bytes are the tag)
    ciphertext = ct_with_tag[:-_TAG_LENGTH]
    tag = ct_with_tag[-_TAG_LENGTH:]

    iv_b64 = base64.b64encode(iv).decode("ascii")
    tag_b64 = base64.b64encode(tag).decode("ascii")
    data_b64 = base64.b64encode(ciphertext).decode("ascii")

    return f"{iv_b64}:{tag_b64}:{data_b64}"


def decrypt(stored: str) -> str:
    """Decrypt a ``iv:tag:data`` base64 string back to plaintext.

    Wire-compatible with the TypeScript ``decrypt()`` function.
    """
    iv_b64, tag_b64, data_b64 = stored.split(":")

    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ciphertext = base64.b64decode(data_b64)

    # AESGCM.decrypt expects ciphertext || tag
    ct_with_tag = ciphertext + tag
    plaintext_bytes = _aesgcm.decrypt(iv, ct_with_tag, None)

    return plaintext_bytes.decode("utf-8")
