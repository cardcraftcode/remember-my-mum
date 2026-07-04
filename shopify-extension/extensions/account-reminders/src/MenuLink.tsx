import {
  reactExtension,
  Link,
} from "@shopify/ui-extensions-react/customer-account";

// Renders a "Reminders" link on the customer account order-index page,
// which opens the full page defined in ReminderPage.tsx.
export default reactExtension(
  "customer-account.order-index.block.render",
  () => <Link to="extension:/">Reminders</Link>,
);
