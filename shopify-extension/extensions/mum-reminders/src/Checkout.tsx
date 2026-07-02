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

function MumReminders() {
  const { i18n } = useApi();
  const settings = useSettings();
  const email = useEmail();
  const order = useOrder();

  const backendUrl = (settings.backend_url as string | undefined)?.replace(
    /\/$/,
    "",
  );

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
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/public/hooks/save-reminders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          order_id: order?.id ?? null,
          mum_birthday: birthday || null,
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
        Set reminders for Mum's birthday, Christmas, and Mother's Day. We'll
        email you in time to order.
      </Text>

      <TextField
        label="Mum's birthday (DD/MM)"
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
        <Button
          kind="primary"
          onPress={save}
          loading={status === "saving"}
        >
          {i18n.translate ? "Save reminders" : "Save reminders"}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
