import { Alert, Platform } from "react-native";

// Shows an alert using the appropriate behavior for web or native platforms.
export function showAlert(title, message, buttons) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(`${title}\n\n${message}`);
    buttons?.[0]?.onPress?.();
    return;
  }

  Alert.alert(title, message, buttons);
}