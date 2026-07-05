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

type Person = {
  id?: string;
  name: string;
  dateOfBirth: string; // YYYY-MM-DD
  mumVariants: string[];
  remindsBirthday: boolean;
};

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "ok" | "error";

function emptyPerson(): Person {
  return { name: "", dateOfBirth: "", mumVariants: [], remindsBirthday: true };
}

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

  const [people, setPeople] = useState<Person[]>([]);
  const [christmasOn, setChristmasOn] = useState(true);
  const [mothersDayOn, setMothersDayOn] = useState(true);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

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
        const res = await fetch(`${backendUrl}/api/public/shopify/reminders`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          people?: Person[];
          remindsChristmas?: boolean;
          remindsMothersDay?: boolean;
        };
        if (cancelled) return;
        setPeople(data.people ?? []);
        setChristmasOn(data.remindsChristmas ?? true);
        setMothersDayOn(data.remindsMothersDay ?? true);
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

  const updatePerson = (i: number, patch: Partial<Person>) =>
    setPeople((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const removePerson = (i: number) =>
    setPeople((prev) => prev.filter((_, idx) => idx !== i));

  const addPerson = () => setPeople((prev) => [...prev, emptyPerson()]);

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

    const cleaned = people
      .filter((p) => p.name.trim() && /^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth))
      .map((p) => ({
        name: p.name.trim(),
        dateOfBirth: p.dateOfBirth,
        mumVariants: p.mumVariants,
      }));

    setSaveState("saving");
    setSaveError(null);
    try {
      const token = await sessionToken.get();
      const res = await fetch(`${backendUrl}/api/public/shopify/reminders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email,
          shopDomain: (settings.shop_domain as string) ?? "",
          people: cleaned,
          remindsChristmas: christmasOn,
          remindsMothersDay: mothersDayOn,
        }),
      });
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
              Add each person you'd like a birthday reminder for. Then choose
              whether you want Mother's Day and Christmas reminders too.
            </Text>

            {people.length === 0 && (
              <Text>You haven't added anyone yet.</Text>
            )}

            {people.map((person, i) => (
              <BlockStack key={person.id ?? i} spacing="tight">
                <TextField
                  label="Name"
                  value={person.name}
                  onChange={(v) => updatePerson(i, { name: v })}
                />
                <TextField
                  label="Date of birth (YYYY-MM-DD)"
                  value={person.dateOfBirth}
                  onChange={(v) => updatePerson(i, { dateOfBirth: v })}
                  placeholder="1955-03-15"
                />
                <Checkbox
                  checked={person.remindsBirthday}
                  onChange={(v) => updatePerson(i, { remindsBirthday: v })}
                >
                  Birthday reminder
                </Checkbox>
                <InlineStack>
                  <Button kind="plain" onPress={() => removePerson(i)}>
                    Remove
                  </Button>
                </InlineStack>
              </BlockStack>
            ))}

            <InlineStack>
              <Button kind="secondary" onPress={addPerson}>
                + Add person
              </Button>
            </InlineStack>

            <BlockStack spacing="tight">
              <Text emphasis="bold">Account reminders</Text>
              <Checkbox checked={mothersDayOn} onChange={setMothersDayOn}>
                Mother's Day reminder
              </Checkbox>
              <Checkbox checked={christmasOn} onChange={setChristmasOn}>
                Christmas reminder
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
