import { pageMetadata } from "@/i18n/metadata";
import { UsersView } from "@/features/users/components/users-view";

export const generateMetadata = pageMetadata("users");

export default function Page() {
  return <UsersView />;
}
