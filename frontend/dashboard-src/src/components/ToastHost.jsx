import { useToast } from "../hooks/useToast";

export default function ToastHost() {
  const { message, visible } = useToast();
  return (
    <div className={`toast${visible ? " show" : ""}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
