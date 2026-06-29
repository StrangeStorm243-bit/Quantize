"""Registry-infrastructure errors.

These signal misuse of the registry API itself (a programming/catalog-assembly bug). Unknown node
types and unavailable versions are NOT errors here — they are non-throwing ``NodeResolution``
results (see ``registry.py``). Descriptor construction failures are ordinary Pydantic
``ValidationError``s, not ``RegistryError``s.
"""

from __future__ import annotations


class RegistryError(Exception):
    """Base class for registry-infrastructure errors."""


class DuplicateRegistrationError(RegistryError):
    """Raised when a ``(type_id, type_version)`` is registered more than once."""

    def __init__(self, type_id: str, type_version: str) -> None:
        self.type_id = type_id
        self.type_version = type_version
        super().__init__(f"node type {type_id!r} version {type_version!r} is already registered")
