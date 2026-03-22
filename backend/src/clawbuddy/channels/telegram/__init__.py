"""Telegram channel package."""

from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager
from clawbuddy.channels.telegram.emit import create_telegram_emit
from clawbuddy.channels.telegram.format_telegram import (
    markdown_to_telegram_html,
    split_html_message,
)
from clawbuddy.channels.telegram.handler import (
    create_new_session,
    handle_telegram_message,
)

__all__ = [
    "create_new_session",
    "create_telegram_emit",
    "handle_telegram_message",
    "markdown_to_telegram_html",
    "split_html_message",
    "telegram_bot_manager",
]
