"""Authentication schemas.

Replaces: packages/shared/src/schemas/auth.schema.ts
"""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class LoginInput(BaseModel):
    """Login request body."""

    email: EmailStr
    password: str = Field(min_length=8, description="Password must be at least 8 characters")


class RegisterInput(BaseModel):
    """Registration request body."""

    name: str = Field(min_length=2, description="Name must be at least 2 characters")
    email: EmailStr
    password: str = Field(min_length=8, description="Password must be at least 8 characters")
