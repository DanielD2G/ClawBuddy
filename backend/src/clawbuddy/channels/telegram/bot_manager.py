"""Telegram bot manager — aiogram 3 bot lifecycle management.

Replaces: apps/api/src/channels/telegram/telegram-bot-manager.ts (Grammy)

Manages multiple Telegram bots (one per channel). Each bot handles:
- /new: start a new conversation
- /help: show available commands
- /start: welcome message
- Regular text messages: forwarded to the agent loop
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any

from aiogram import Bot, Dispatcher, Router, F
from aiogram.enums import ParseMode, ChatAction
from aiogram.filters import Command
from aiogram.types import Message
from loguru import logger

from clawbuddy.channels.telegram.format_telegram import (
    markdown_to_telegram_html,
    split_html_message,
    split_plain_message,
    strip_markdown,
)
from clawbuddy.channels.telegram.handler import (
    create_new_session,
    handle_telegram_message,
)


@dataclass
class BotEntry:
    """Tracks a running bot instance."""

    bot: Bot
    dispatcher: Dispatcher
    workspace_id: str
    task: asyncio.Task[Any] | None = None


class TelegramBotManager:
    """Manages multiple Telegram bot instances, one per channel."""

    def __init__(self) -> None:
        self._bots: dict[str, BotEntry] = {}

    def find_by_workspace(self, workspace_id: str) -> BotEntry | None:
        """Find the bot entry for a given workspace."""
        for entry in self._bots.values():
            if entry.workspace_id == workspace_id:
                return entry
        return None

    async def send_to_chat(
        self, workspace_id: str, chat_id: str, text: str
    ) -> None:
        """Send a formatted message to a Telegram chat proactively.

        Used by cron jobs and other background processes to forward
        content to Telegram outside of a handler context.
        """
        entry = self.find_by_workspace(workspace_id)
        if not entry:
            logger.warning(
                f"[Telegram] No active bot for workspace {workspace_id}, "
                f"cannot send message"
            )
            return
        await self._send_formatted_message(entry.bot, chat_id, text)

    async def _send_formatted_message(
        self, bot: Bot, chat_id: str | int, text: str
    ) -> None:
        """Send a message with HTML formatting, splitting, and plain-text fallback."""
        html = markdown_to_telegram_html(text)
        try:
            if len(html) <= 4096:
                await bot.send_message(
                    chat_id=int(chat_id) if isinstance(chat_id, str) else chat_id,
                    text=html,
                    parse_mode=ParseMode.HTML,
                )
            else:
                parts = split_html_message(html, 4096)
                for part in parts:
                    await bot.send_message(
                        chat_id=int(chat_id) if isinstance(chat_id, str) else chat_id,
                        text=part,
                        parse_mode=ParseMode.HTML,
                    )
        except Exception as exc:
            logger.warning(f"[Telegram] HTML send failed, retrying as plain text: {exc}")
            plain = strip_markdown(text)
            cid = int(chat_id) if isinstance(chat_id, str) else chat_id
            if len(plain) <= 4096:
                await bot.send_message(chat_id=cid, text=plain)
            else:
                parts = split_plain_message(plain, 4096)
                for part in parts:
                    await bot.send_message(chat_id=cid, text=part)

    async def start_bot(
        self, channel_id: str, bot_token: str, workspace_id: str
    ) -> str:
        """Start a Telegram bot for a channel. Returns the bot username."""
        # Stop existing bot for this channel if running
        if channel_id in self._bots:
            await self.stop_bot(channel_id)

        bot = Bot(token=bot_token)
        dp = Dispatcher()
        router = Router()

        manager = self  # capture for closures

        @router.message(Command("new"))
        async def cmd_new(message: Message) -> None:
            telegram_chat_id = str(message.chat.id)
            await create_new_session(workspace_id, telegram_chat_id)
            await message.reply("New conversation started. How can I help you?")

        @router.message(Command("help"))
        async def cmd_help(message: Message) -> None:
            await message.reply(
                "Available commands:\n"
                "/new — Start a new conversation\n"
                "/help — Show this help message\n\n"
                "Just send any message to chat with the assistant."
            )

        @router.message(Command("start"))
        async def cmd_start(message: Message) -> None:
            await message.reply(
                "Welcome! I'm your AI assistant.\n\n"
                "Just send me a message and I'll help you.\n"
                "Use /new to start a fresh conversation.\n"
                "Use /help for more commands."
            )

        @router.message(F.text)
        async def on_text_message(message: Message) -> None:
            if not message.text:
                return
            telegram_chat_id = str(message.chat.id)
            text = message.text

            # Show "typing..." indicator
            await bot.send_chat_action(
                chat_id=message.chat.id, action=ChatAction.TYPING
            )

            # Keep refreshing typing every 4 seconds (Telegram expires after 5s)
            typing_active = True

            async def typing_loop() -> None:
                while typing_active:
                    await asyncio.sleep(4)
                    if typing_active:
                        try:
                            await bot.send_chat_action(
                                chat_id=message.chat.id,
                                action=ChatAction.TYPING,
                            )
                        except Exception:
                            pass

            typing_task = asyncio.create_task(typing_loop())

            try:
                async def send_fn(msg: str) -> None:
                    await manager._send_formatted_message(bot, message.chat.id, msg)

                await handle_telegram_message(
                    workspace_id, telegram_chat_id, text, send_fn
                )
            except Exception as exc:
                logger.error(f"[Telegram] Error handling message: {exc}")
                await message.reply(
                    "Sorry, an error occurred while processing your message. "
                    "Please try again."
                )
            finally:
                typing_active = False
                typing_task.cancel()
                try:
                    await typing_task
                except asyncio.CancelledError:
                    pass

        dp.include_router(router)

        # Get bot info
        bot_info = await bot.get_me()
        bot_username = bot_info.username or ""

        # Start polling in background task
        async def _run_polling() -> None:
            logger.info(
                f"[Telegram] Bot @{bot_username} started for channel {channel_id}"
            )
            try:
                await dp.start_polling(bot, handle_signals=False)
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.error(
                    f"[Telegram] Bot polling error (channel {channel_id}): {exc}"
                )

        task = asyncio.create_task(_run_polling())

        self._bots[channel_id] = BotEntry(
            bot=bot,
            dispatcher=dp,
            workspace_id=workspace_id,
            task=task,
        )

        return bot_username

    async def stop_bot(self, channel_id: str) -> None:
        """Stop a running bot for a channel."""
        entry = self._bots.get(channel_id)
        if not entry:
            return

        try:
            await entry.dispatcher.stop_polling()
            await entry.bot.session.close()
        except Exception:
            pass

        if entry.task and not entry.task.done():
            entry.task.cancel()
            try:
                await entry.task
            except (asyncio.CancelledError, Exception):
                pass

        del self._bots[channel_id]
        logger.info(f"[Telegram] Bot stopped for channel {channel_id}")

    async def stop_all(self) -> None:
        """Stop all running bots (for graceful shutdown)."""
        channel_ids = list(self._bots.keys())
        results = await asyncio.gather(
            *(self.stop_bot(cid) for cid in channel_ids),
            return_exceptions=True,
        )
        for cid, result in zip(channel_ids, results):
            if isinstance(result, Exception):
                logger.error(f"[Telegram] Error stopping bot {cid}: {result}")

    def is_running(self, channel_id: str) -> bool:
        """Check if a bot is running for a channel."""
        return channel_id in self._bots


telegram_bot_manager = TelegramBotManager()
