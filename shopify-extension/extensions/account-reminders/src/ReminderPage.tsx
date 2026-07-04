import {
  reactExtension,
  BlockStack,
  InlineStack,
  Page,
  Card,
  Text,
  TextField,
  Checkbox,
  Button,
  Banner,
  Spinner,
  useApi,
  useSettings,
  useAuthenticatedAccountCustomer,
  useSessionToken,
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useState } from "react";

export default reactExtension("customer-account.page.render", () => (
  <ReminderPage />
));

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "ok" | "error";

function ReminderPage() {
  const { i18n } = useApi();
  const settings = useSettings();
  const customer = useAuthenticatedAccountCustomer();
  const sessionToken = useSessionToken();

  const backendUrl = (settings.backend_url as string | undefined)?.replace(
    /\/$/,
    "",
  );

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  // Single-birthday shape for v1; the backend accepts multi-birthday too.
  const [birthday, setBirthday] = useState("");
  const [birthdayOn, setBirthdayOn] = useState(true);
  const [christmasOn, setChristmasOn] = useState(true);
  const [mothersDayOn, setMothersDayOn] = useState(true);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load existing reminders on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!backendUrl) {
        setLoadError("Extension not configured (missing backend URL).");
        setLoadState("error");
        return;
      }
      try {
        const token = await sessionToken.get();
        const res = await fetch(
          `${backendUrl}/api/public/shopify/reminders`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          birthdays?: Array<{ date: string }>;
          remindsChristmas?: boolean;
          remindsMothersDay?: boolean;
        };
        if (cancelled) return;
        setBirthday(data.birthdays?.[0]?.date ?? "");
        setBirthdayOn((data.birthdays?.length ?? 0) > 0);
        setChristmasOn(data.remindsChristmas ?? false);
        setMothersDayOn(data.remindsMothersDay ?? false);
        setLoadState("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Unknown error");
        setLoadState("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [backendUrl, sessionToken]);

  const save = async () => {
    if (!backendUrl) {
      setSaveError("Extension not configured (missing backend URL).");
      setSaveState("error");
      return;
    }
    const email = customer?.emailAddress?.emailAddress;
    if (!email) {
      setSaveError("No email on your account.");
      setSaveState("error");
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    try {
      const token = await sessionToken.get();
      const res = await fetch(
        `${backendUrl}/api/public/shopify/reminders`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            email,
            shopDomain: (settings.shop_domain as string) ?? "",
            birthdays:
              birthdayOn && birthday ? [{ date: birthday, mumVariants: [] }] : [],
            remindsBirthday: birthdayOn,
            remindsChristmas: christmasOn,
            remindsMothersDay: mothersDayOn,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveState("ok");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Unknown error");
      setSaveState("error");
    }
  };

  return (
    <Page title="Reminders">
      <Card>
        {loadState === "loading" && (
          <InlineStack>
            <Spinner />
            <Text>Loading your reminders…</Text>
          </InlineStack>
        )}

        {loadState === "error" && (
          <Banner status="critical" title="Couldn't load reminders">
            {loadError}
          </Banner>
        )}

        {loadState === "ready" && (
          <BlockStack spacing="base">
            <Text>
              Set reminders for Mum's birthday, Christmas, and Mother's Day.
              We'll email you in time to order.
            </Text>

            <TextField
              label="Mum's birthday (YYYY-MM-DD)"
              value={birthday}
              onChange={setBirthday}
              placeholder="1955-03-15"
            />

            <BlockStack spacing="tight">
              <Checkbox checked={birthdayOn} onChange={setBirthdayOn}>
                Birthday reminder
              </Checkbox>
              <Checkbox checked={christmasOn} onChange={setChristmasOn}>
                Christmas reminder
              </Checkbox>
              <Checkbox checked={mothersDayOn} onChange={setMothersDayOn}>
                Mother's Day reminder
              </Checkbox>
            </BlockStack>

            {saveState === "ok" && (
              <Banner status="success" title="Reminders saved">
                We'll email you before each occasion.
              </Banner>
            )}
            {saveState === "error" && saveError && (
              <Banner status="critical" title="Couldn't save">
                {saveError}
              </Banner>
            )}

            <InlineStack>
              <Button
                kind="primary"
                onPress={save}
                loading={saveState === "saving"}
              >
                {i18n.translate ? "Save reminders" : "Save reminders"}
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </Card>
    </Page>
  );
}
