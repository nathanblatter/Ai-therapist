import { useState } from "react";
import { Copy } from "react-feather";

export default function CopyButton({ textToCopy }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
  onClick={handleCopy}
  className="flex items-center space-x-1 text-gray-200 hover:text-white px-2 py-1 rounded hover:bg-white/10 transition text-sm"
  title="Copy to clipboard"
>

    <Copy size={16} className="text-gray-200 group-hover:text-white" />
      <span>{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}
