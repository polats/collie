import { useSyncExternalStore } from "react";

import { Notice } from "@/components/ui/notice";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { useLocale } from "@/hooks/use-locale";
import {
  ACCOUNT_NAMES,
  dismissAccountSave,
  getAccountSaveState,
  subscribeAccountSave,
} from "@/lib/accounts-connect";
import { t } from "@/lib/i18n";

/**
 * Saving a connected agent account to the user's GitHub account (lib/accounts-connect.ts). An
 * event, so it floats: it passes once the save lands, and it never holds space on whichever route
 * the sign-in pane happens to be on. Mounted once, beside the router, because the save outlives any
 * one screen.
 */
export function AccountSaveStatus() {
  useLocale();
  const state = useSyncExternalStore(subscribeAccountSave, getAccountSaveState);
  if (state.kind === "idle") return null;
  const agent = ACCOUNT_NAMES[state.agent];
  return (
    <ToastViewport>
      {state.kind === "saving" ? (
        <Notice tone="info" variant="box" announce="status">
          {t("accounts.saving", { agent })}
        </Notice>
      ) : state.kind === "saved" ? (
        <Notice tone="success" variant="box" announce="status" onDismiss={dismissAccountSave} dismissLabel={t("accounts.dismiss")}>
          {t("accounts.saved", { agent })}
        </Notice>
      ) : state.kind === "no-token" ? (
        <Notice tone="neutral" variant="box" announce="status" onDismiss={dismissAccountSave} dismissLabel={t("accounts.dismiss")}>
          {t("accounts.noToken", { agent })}
        </Notice>
      ) : (
        <Notice tone="danger" variant="box" announce="alert" onDismiss={dismissAccountSave} dismissLabel={t("accounts.dismiss")}>
          {t("accounts.failed", { agent, reason: state.reason })}
        </Notice>
      )}
    </ToastViewport>
  );
}
