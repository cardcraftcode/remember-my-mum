import {
  reactExtension,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Button,
  Banner,
  useApi,
  useSettings,
  useEmail,
  useOrder,
} from "@shopify/ui-extensions-react/checkout";
import { useState } from "react";

const MUM_VARIANTS = [
  "Mom",
  "Mommy",
  "Stepmom",
  "Mam",
  "Mammy",
  "Stepmam",
  "Mum",
  "Mummy",
  "Stepmum",
  "Ma",
  "Mama",
  "Amma",
  "Ammi",
  "Maw",
  "Mother",
];

export default reactExtension(
  "purchase.thank-you.block.render",
  () => <MumReminders />,
);

// Parse "DD/MM/YYYY" into ISO YYYY-MM-DD.
function toIso(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) return null;
  const [dd, mm, yyyy] = trimmed.split("/");
  return `${yyyy}-${mm}-${dd}`;
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
  const [variant, setVariant] = useState("Mum");
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

    const iso = toIso(birthday);
    if (!name.trim() || !iso) {
      setError("Please enter a name and full date of birth in DD/MM/YYYY format.");
      setStatus("error");
      return;
    }
    if (!birthdayOn && !christmasOn && !mothersDayOn) {
      setError("Please pick at least one reminder.");
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
          people: [
            {
              name: name.trim(),
              dateOfBirth: iso,
              variant,
              remindsBirthday: birthdayOn,
              remindsChristmas: christmasOn,
              remindsMothersDay: mothersDayOn,
            },
          ],
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
        Check your inbox to confirm — we'll email you before each occasion.
      </Banner>
    );
  }

  return (
    <BlockStack spacing="base">
      <Text size="medium" emphasis="bold">
        Never forget an occasion
      </Text>
      <Text>
        Set birthday, Christmas and Mother's Day reminders — we'll email you in
        time to order a card.
      </Text>

      <TextField
        label="Who is the reminder for?"
        value={name}
        onChange={setName}
        placeholder="Mum, Nana Rose, etc."
      />

      <Select
        label="What is she known as?"
        value={variant}
        onChange={setVariant}
        options={MUM_VARIANTS.map((v) => ({ label: v, value: v }))}
      />

      <BlockStack spacing="tight">
        <Text emphasis="bold">Reminder about</Text>
        <Checkbox checked={birthdayOn} onChange={setBirthdayOn}>
          Birthday
        </Checkbox>
        <Checkbox checked={christmasOn} onChange={setChristmasOn}>
          Christmas
        </Checkbox>
        <Checkbox checked={mothersDayOn} onChange={setMothersDayOn}>
          Mother's Day
        </Checkbox>
      </BlockStack>

      <TextField
        label="When was she born? (DD/MM/YYYY)"
        value={birthday}
        onChange={setBirthday}
        placeholder="15/03/1955"
      />

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
