import { ErrorState } from "../components/ErrorState";

export default function NotFound() {
  return <ErrorState title="Page not found" message="The requested route is unavailable in this workspace." />;
}
