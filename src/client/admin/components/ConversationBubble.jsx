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
    if (message.role === 'user') {
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
          <div className="whitespace-pre-line">{message.message || '(No message content)'}</div>
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
