import {
  reactExtension,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Checkbox,
  Button,
  Banner,
  useApi,
  useSettings,
  useEmail,
  useOrder,
} from "@shopify/ui-extensions-react/checkout";
import { useState } from "react";

export default reactExtension(
  "purchase.thank-you.block.render",
  () => <MumReminders />,
);

// Parse "DD/MM" or "DD/MM/YYYY" into ISO YYYY-MM-DD (year defaults to 2000
// when the customer only gives us day and month).
function toIso(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\d{2}\/\d{2}(?:\/\d{4})?$/.test(trimmed)) return null;
  const [dd, mm, yyyy] = trimmed.split("/");
  return `${yyyy ?? "2000"}-${mm}-${dd}`;
}

function MumReminders() {
  const { i18n } = useApi();
  const settings = useSettings();
  const email = useEmail();
  const order = useOrder();

  const backendUrl = (settings.backend_url as string | undefined)?.replace(
    /\/$/,
    "",
  );

  const [name, setName] = useState("");
  const [birthday, setBirthday] = useState("");
  const [birthdayOn, setBirthdayOn] = useState(true);
  const [christmasOn, setChristmasOn] = useState(true);
  const [mothersDayOn, setMothersDayOn] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!email) {
      setError("No email on order — can't save reminders.");
      setStatus("error");
      return;
    }
    if (!backendUrl) {
      setError("Extension not configured (missing backend URL).");
      setStatus("error");
      return;
    }

    const iso = birthday ? toIso(birthday) : null;
    if (birthdayOn && (!name.trim() || !iso)) {
      setError("Please enter a name and a birthday in DD/MM format.");
      setStatus("error");
      return;
    }

    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/public/hooks/save-reminders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          order_id: order?.id ?? null,
          people:
            birthdayOn && iso && name.trim()
              ? [{ name: name.trim(), dateOfBirth: iso, mumVariants: [] }]
              : [],
          reminders: {
            birthday: birthdayOn,
            christmas: christmasOn,
            mothers_day: mothersDayOn,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setStatus("error");
    }
  };

  if (status === "ok") {
    return (
      <Banner status="success" title="Reminders saved">
        We'll email you before each occasion.
      </Banner>
    );
  }

  return (
    <BlockStack spacing="base">
      <Text size="medium" emphasis="bold">
        Never forget an occasion
      </Text>
      <Text>
        Set a birthday reminder plus Christmas and Mother's Day — we'll email
        you in time to order a card.
      </Text>

      <TextField
        label="Name"
        value={name}
        onChange={setName}
        placeholder="Mum, Nana Rose, etc."
      />

      <TextField
        label="Birthday (DD/MM)"
        value={birthday}
        onChange={setBirthday}
        placeholder="15/03"
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

      {error && (
        <Banner status="critical" title="Couldn't save">
          {error}
        </Banner>
      )}

      <InlineStack>
        <Button kind="primary" onPress={save} loading={status === "saving"}>
          {i18n.translate ? "Set reminders" : "Set reminders"}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
