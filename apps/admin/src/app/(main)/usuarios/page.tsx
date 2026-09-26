import type { Metadata } from "next";
import { UsersView } from "@/features/users/components/users-view";

export const metadata: Metadata = { title: "Usuarios" };

export default function Page() {
  return <UsersView />;
}
