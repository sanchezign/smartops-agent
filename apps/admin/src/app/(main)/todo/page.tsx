import { pageMetadata } from "@/i18n/metadata";
import { TodoView } from "@/features/todo/components/todo-view";

export const generateMetadata = pageMetadata("todo");

export default function Page() {
  return <TodoView />;
}
