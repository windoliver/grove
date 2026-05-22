import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { type ReactNode, useCallback, useState } from "react";
import { useTextInput } from "./hooks/use-text-input.js";
import { theme } from "./theme.js";

export type DialogId = string | number;

export interface PromptDialogContext<T> {
  readonly resolve: (value: T) => void;
  readonly dismiss: () => void;
  readonly dialogId: DialogId;
}

export interface RuntimePromptOptions<T> {
  readonly content: (ctx: PromptDialogContext<T>) => ReactNode;
  readonly fallback?: T | undefined;
}

export interface TextPromptDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly defaultValue?: string | undefined;
}

export interface ChoiceDialogOptions<K extends string> {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly K[];
}

export function textPromptDialogOptions(
  options: TextPromptDialogOptions,
): RuntimePromptOptions<string> {
  return {
    content: (ctx) => (
      <TextPromptDialog
        title={options.title}
        message={options.message}
        defaultValue={options.defaultValue ?? ""}
        resolve={ctx.resolve}
        dismiss={ctx.dismiss}
        dialogId={ctx.dialogId}
      />
    ),
  };
}

export function choiceDialogOptions<const K extends string>(
  options: ChoiceDialogOptions<K>,
): RuntimePromptOptions<K> {
  return {
    content: (ctx) => (
      <ChoiceDialog
        title={options.title}
        message={options.message}
        choices={options.choices}
        resolve={ctx.resolve}
        dismiss={ctx.dismiss}
        dialogId={ctx.dialogId}
      />
    ),
  };
}

interface TextPromptDialogProps {
  readonly title: string;
  readonly message: string;
  readonly defaultValue: string;
  readonly resolve: (value: string) => void;
  readonly dismiss: () => void;
  readonly dialogId: DialogId;
}

function TextPromptDialog({
  title,
  message,
  defaultValue,
  resolve,
  dismiss,
  dialogId,
}: TextPromptDialogProps): ReactNode {
  const input = useTextInput(defaultValue);

  useDialogKeyboard(
    useCallback(
      (key) => {
        if (key.name === "return") {
          resolve(input.value);
          return;
        }
        if (key.name === "escape") {
          dismiss();
          return;
        }
        input.onKey(key);
      },
      [dismiss, input, resolve],
    ),
    dialogId,
  );

  const before = input.value.slice(0, input.cursor);
  const after = input.value.slice(input.cursor);

  return (
    <box flexDirection="column" paddingX={1}>
      <text color={theme.focus} bold>
        {title}
      </text>
      <text color={theme.secondary}>{message}</text>
      <box flexDirection="row" marginTop={1}>
        <text color={theme.focus}>{"> "}</text>
        <text color={theme.text}>{before}</text>
        <text color={theme.focus}>_</text>
        <text color={theme.text}>{after}</text>
      </box>
      <text color={theme.secondary}>Enter submit, Esc cancel</text>
    </box>
  );
}

interface ChoiceDialogProps<K extends string> {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly K[];
  readonly resolve: (value: K) => void;
  readonly dismiss: () => void;
  readonly dialogId: DialogId;
}

function ChoiceDialog<K extends string>({
  title,
  message,
  choices,
  resolve,
  dismiss,
  dialogId,
}: ChoiceDialogProps<K>): ReactNode {
  const [cursor, setCursor] = useState(0);

  useDialogKeyboard(
    useCallback(
      (key) => {
        if (key.name === "escape") {
          dismiss();
          return;
        }
        if (key.name === "j" || key.name === "down") {
          setCursor((current) => Math.min(current + 1, Math.max(0, choices.length - 1)));
          return;
        }
        if (key.name === "k" || key.name === "up") {
          setCursor((current) => Math.max(current - 1, 0));
          return;
        }
        if (key.name === "return") {
          const selected = choices[Math.min(cursor, Math.max(0, choices.length - 1))];
          if (selected === undefined) dismiss();
          else resolve(selected);
        }
      },
      [choices, cursor, dismiss, resolve],
    ),
    dialogId,
  );

  return (
    <box flexDirection="column" paddingX={1}>
      <text color={theme.focus} bold>
        {title}
      </text>
      <text color={theme.secondary}>{message}</text>
      <box flexDirection="column" marginTop={1}>
        {choices.length === 0 ? (
          <text color={theme.secondary}>No choices available</text>
        ) : (
          choices.map((choice, index) => (
            <box key={choice} flexDirection="row">
              <text color={index === cursor ? theme.focus : theme.text}>
                {index === cursor ? "> " : "  "}
                {choice}
              </text>
            </box>
          ))
        )}
      </box>
      <text color={theme.secondary}>j/k move, Enter select, Esc cancel</text>
    </box>
  );
}
