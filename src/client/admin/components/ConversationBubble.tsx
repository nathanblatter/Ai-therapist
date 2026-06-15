export default function ConversationBubble({
  message,
  isEditMode = false,
  isEditing = false,
  editedContent = '',
  onEdit,
  onSave,
  onDelete,
  onCancel,
  onContentChange,
  userRole
}) {
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const getBubbleClass = () => {
    // Tool calls get special styling
    if (message.message_type === 'tool_call') {
      return 'bg-purple-100 text-purple-900 border-2 border-purple-400 rounded-none justify-center';
    } else if (message.message_type === 'tool_response') {
      return 'bg-purple-50 text-purple-800 border border-purple-300 rounded-none justify-center';
    } else if (message.role === 'user') {
      return 'bg-byuRoyal text-white rounded-br-none justify-end';
    } else if (message.role === 'assistant') {
      return 'bg-byuLightBlue text-black rounded-bl-none justify-start';
    } else {
      return 'bg-gray-200 text-gray-700 rounded-none justify-center';
    }
  };

  const getContentFieldLabel = () => {
    return userRole === 'therapist' ? 'Unredacted Content' : 'Redacted Content';
  };

  return (
    <div className={`flex w-full mb-3 ${message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : 'justify-center'}`}>
      <div className={`max-w-xl px-4 py-3 rounded-2xl ${getBubbleClass()}`}>
        <div className="text-xs opacity-70 mb-1">
          {message.role.toUpperCase()} | {message.message_type} | {formatTime(message.created_at)}
        </div>

        {/* Visual indicator for which field is being edited */}
        {isEditMode && isEditing && (
          <div className="mb-2 text-xs font-semibold bg-yellow-200 text-yellow-900 px-2 py-1 rounded inline-block">
            Editing: {getContentFieldLabel()}
          </div>
        )}

        {/* Message content or edit textarea */}
        {isEditing ? (
          <textarea
            value={editedContent}
            onChange={(e) => onContentChange(e.target.value)}
            className="w-full p-2 border rounded text-black min-h-[100px]"
            rows={4}
          />
        ) : (
          <div>
            {message.message_type === 'tool_call' && (
              <div className="font-semibold text-purple-900 mb-2">🔧 Tool Call</div>
            )}
            {message.message_type === 'tool_response' && (
              <div className="font-semibold text-purple-800 mb-2">📥 Tool Response</div>
            )}
            {userRole === 'researcher' && !message.message ? (
              <div className="text-gray-400 italic flex items-center">
                <svg className="animate-spin inline w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Redacting content...
              </div>
            ) : (
              <div className="whitespace-pre-line">{message.message || '(No message content)'}</div>
            )}
            {message.metadata && (message.message_type === 'tool_call' || message.message_type === 'tool_response') && (
              <div className="mt-2 p-2 bg-white bg-opacity-50 rounded text-xs">
                <div><strong>Tool:</strong> {message.metadata.tool_name}</div>
                {message.metadata.status && (
                  <div><strong>Status:</strong> <span className={message.metadata.status === 'completed' ? 'text-green-700' : message.metadata.status === 'failed' ? 'text-red-700' : 'text-yellow-700'}>{message.metadata.status}</span></div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Edit indicator */}
        {message.extras?.edited && !isEditing && (
          <div className="text-xs italic opacity-60 mt-1">
            (Edited{message.extras.edited_at ? ` at ${formatTime(message.extras.edited_at)}` : ''})
          </div>
        )}

        {/* Metadata display */}
        {message.extras && !isEditing && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer hover:underline">Metadata</summary>
            <pre className="mt-1 bg-white bg-opacity-20 p-2 rounded overflow-x-auto">
              {JSON.stringify(message.extras, null, 2)}
            </pre>
          </details>
        )}

        {/* Edit mode buttons */}
        {isEditMode && !isEditing && (
          <div className="mt-2 flex gap-2">
            <button
              onClick={onEdit}
              className="text-xs bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 transition"
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600 transition"
            >
              Delete
            </button>
          </div>
        )}

        {/* Save/Cancel buttons when editing */}
        {isEditMode && isEditing && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={onSave}
              className="text-xs bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 transition"
            >
              Save
            </button>
            <button
              onClick={onCancel}
              className="text-xs bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 transition"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
