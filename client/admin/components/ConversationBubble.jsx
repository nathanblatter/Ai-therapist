export default function ConversationBubble({ message }) {
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const getBubbleClass = () => {
    if (message.role === 'user') {
      return 'bg-byuRoyal text-white rounded-br-none justify-end';
    } else if (message.role === 'assistant') {
      return 'bg-byuLightBlue text-black rounded-bl-none justify-start';
    } else {
      return 'bg-gray-200 text-gray-700 rounded-none justify-center';
    }
  };

  return (
    <div className={`flex w-full mb-3 ${message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : 'justify-center'}`}>
      <div className={`max-w-xl px-4 py-3 rounded-2xl ${getBubbleClass()}`}>
        <div className="text-xs opacity-70 mb-1">
          {message.role.toUpperCase()} | {message.message_type} | {formatTime(message.created_at)}
        </div>
        <div className="whitespace-pre-line">{message.message || '(No message content)'}</div>
        {message.extras && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer hover:underline">Metadata</summary>
            <pre className="mt-1 bg-white bg-opacity-20 p-2 rounded overflow-x-auto">
              {JSON.stringify(message.extras, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
