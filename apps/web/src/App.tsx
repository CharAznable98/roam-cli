import { AppShell } from "./app/AppShell";
import { useRoamController } from "./app/useRoamController";

export function App() {
  return <AppShell controller={useRoamController()} />;
}
