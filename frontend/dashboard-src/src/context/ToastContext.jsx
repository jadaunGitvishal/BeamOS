import { createContext, useCallback, useRef, useState } from "react";

export const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  const toast = useCallback((m) => {
    setMessage(m);
    setVisible(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 2100);
  }, []);

  return <ToastContext.Provider value={{ message, visible, toast }}>{children}</ToastContext.Provider>;
}
