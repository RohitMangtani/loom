import platform from "./platform/instance.js";
import type { PlatformSendResult } from "./platform/interfaces.js";

const terminal = platform.terminal;

export function sendInputToTty(tty: string, text: string, model?: string): PlatformSendResult {
  return terminal.sendText(tty, text, model);
}

export function sendInputToTtyAsync(
  tty: string,
  text: string,
  model?: string,
): Promise<PlatformSendResult> {
  return terminal.sendTextAsync(tty, text, model);
}

export function sendSelectionToTty(tty: string, optionIndex: number): PlatformSendResult {
  return terminal.sendSelection(tty, optionIndex);
}

export function sendEnterToTty(tty: string): PlatformSendResult {
  return terminal.sendKeystroke(tty, "enter");
}

export function sendEnterToTtyAsync(tty: string): Promise<PlatformSendResult> {
  return terminal.sendKeystrokeAsync(tty, "enter");
}

export function isSendInFlight(): boolean {
  return terminal.isSendInFlight();
}
