import { useState, useEffect, useRef, useCallback } from 'react';
import { Users, Monitor, CheckCircle, X, UserPlus, Activity, List } from 'react-feather';
import { useSocket } from '../hooks/useSocket';
import { toast } from '../../shared/components/Toast';

export default function RoomAssignment() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState({
    rooms: { 1: null, 2: null, 3: null, 4: null, 5: null },
    monitoring: [null, null, null], // 3 monitoring RA positions
    checkIn: [null, null] // 2 check-in RA positions
  });
  const [queues, setQueues] = useState({
    1: [null, null, null, null],
    2: [null, null, null, null],
    3: [null, null, null, null],
    4: [null, null, null, null],
    5: [null, null, null, null]
  });
  const [activeSessions, setActiveSessions] = useState(new Set());
  const [showUserSelector, setShowUserSelector] = useState(null);
  const { socket, connected } = useSocket();

  // Custom drag state
  const [dragState, setDragState] = useState(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dropTargetsRef = useRef(new Map());

  // Local state for unsaved changes
  const [localAssignments, setLocalAssignments] = useState({
    rooms: { 1: null, 2: null, 3: null, 4: null, 5: null },
    monitoring: [null, null, null],
    checkIn: [null, null]
  });
  const [localQueues, setLocalQueues] = useState({
    1: [null, null, null, null],
    2: [null, null, null, null],
    3: [null, null, null, null],
    4: [null, null, null, null],
    5: [null, null, null, null]
  });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    fetchUsers();
    fetchAssignments();
  }, []);

  // Socket.io real-time listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('room-assignment:updated', handleAssignmentUpdated);
    socket.on('room-assignment:removed', handleAssignmentRemoved);
    socket.on('room-queue:updated', handleQueueUpdated);
    socket.on('room-queue:removed', handleQueueRemoved);
    socket.on('session:created', handleSessionCreated);
    socket.on('session:ended', handleSessionEnded);

    return () => {
      socket.off('room-assignment:updated', handleAssignmentUpdated);
      socket.off('room-assignment:removed', handleAssignmentRemoved);
      socket.off('room-queue:updated', handleQueueUpdated);
      socket.off('room-queue:removed', handleQueueRemoved);
      socket.off('session:created', handleSessionCreated);
      socket.off('session:ended', handleSessionEnded);
    };
  }, [socket]);

  const handleAssignmentUpdated = (data) => {
    console.log('[RoomAssignment] Assignment updated:', data);
    fetchAssignments(); // Refetch all assignments to stay in sync
  };

  const handleAssignmentRemoved = (data) => {
    console.log('[RoomAssignment] Assignment removed:', data);
    fetchAssignments();
  };

  const handleQueueUpdated = (data) => {
    console.log('[RoomAssignment] Queue updated:', data);
    fetchAssignments();
  };

  const handleQueueRemoved = (data) => {
    console.log('[RoomAssignment] Queue entry removed:', data);
    fetchAssignments();
  };

  const handleSessionCreated = (data) => {
    console.log('[RoomAssignment] Session created:', data);
    if (data.userId) {
      setActiveSessions(prev => new Set(prev).add(data.userId));
    }
  };

  const handleSessionEnded = (data) => {
    console.log('[RoomAssignment] Session ended:', data);
    // Need to fetch assignments again to get updated active sessions
    fetchAssignments();
  };

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/users');
      if (!response.ok) throw new Error('Failed to fetch users');
      const data = await response.json();
      setUsers(data.users || []);
    } catch (err) {
      console.error('Error fetching users:', err);
      toast.error('Failed to fetch users');
    }
  };

  const fetchAssignments = async () => {
    try {
      setLoading(true);
      const response = await fetch('/admin/api/room-assignments');
      if (!response.ok) throw new Error('Failed to fetch assignments');
      const data = await response.json();

      // Process assignments
      const newAssignments = {
        rooms: { 1: null, 2: null, 3: null, 4: null, 5: null },
        monitoring: [null, null, null],
        checkIn: [null, null]
      };

      data.assignments.forEach(assignment => {
        const assignmentData = {
          assignment_id: assignment.assignment_id,
          userid: assignment.user_id,
          username: assignment.username,
          role: assignment.role
        };

        if (assignment.assignment_type === 'room') {
          newAssignments.rooms[assignment.room_number] = assignmentData;
        } else if (assignment.assignment_type === 'monitoring') {
          newAssignments.monitoring[assignment.position - 1] = assignmentData;
        } else if (assignment.assignment_type === 'checkin') {
          newAssignments.checkIn[assignment.position - 1] = assignmentData;
        }
      });

      setAssignments(newAssignments);

      // Only update local state if there are no unsaved changes
      // This prevents other admins' changes from overwriting local edits
      if (!hasUnsavedChanges) {
        setLocalAssignments(newAssignments);
      }

      // Process queues
      const newQueues = {
        1: [null, null, null, null],
        2: [null, null, null, null],
        3: [null, null, null, null],
        4: [null, null, null, null],
        5: [null, null, null, null]
      };

      data.queue.forEach(queueEntry => {
        const queueData = {
          queue_id: queueEntry.queue_id,
          userid: queueEntry.user_id,
          username: queueEntry.username,
          role: queueEntry.role
        };
        newQueues[queueEntry.room_number][queueEntry.queue_position - 1] = queueData;
      });

      setQueues(newQueues);

      // Only update local state if there are no unsaved changes
      if (!hasUnsavedChanges) {
        setLocalQueues(newQueues);
      }

      // Always update active sessions (independent of unsaved changes)
      const activeUserIds = new Set(data.activeSessions.map(s => s.user_id));
      setActiveSessions(activeUserIds);

    } catch (err) {
      console.error('Error fetching assignments:', err);
      toast.error('Failed to fetch assignments');
    } finally {
      setLoading(false);
    }
  };

  const participants = users.filter(u => u.role === 'participant');
  const researchers = users.filter(u => u.role === 'researcher');

  // Local assignment functions (don't hit API until save)
  const assignUserLocally = (type, id, user, queuePosition = null) => {
    if (type === 'queue') {
      setLocalQueues(prev => {
        const newQueues = JSON.parse(JSON.stringify(prev)); // Deep copy
        newQueues[id][queuePosition - 1] = {
          userid: user.userid,
          username: user.username,
          role: user.role,
          queue_id: null // Will be assigned on save
        };
        return newQueues;
      });
    } else {
      let assignmentType = type;
      if (type === 'checkIn') assignmentType = 'checkin';

      setLocalAssignments(prev => {
        const newAssignments = JSON.parse(JSON.stringify(prev)); // Deep copy

        if (type === 'room') {
          newAssignments.rooms[id] = {
            userid: user.userid,
            username: user.username,
            role: user.role,
            assignment_id: null // Will be assigned on save
          };
        } else if (type === 'monitoring') {
          newAssignments.monitoring[id] = {
            userid: user.userid,
            username: user.username,
            role: user.role,
            assignment_id: null
          };
        } else if (type === 'checkIn') {
          newAssignments.checkIn[id] = {
            userid: user.userid,
            username: user.username,
            role: user.role,
            assignment_id: null
          };
        }

        return newAssignments;
      });
    }

    setHasUnsavedChanges(true);
    setShowUserSelector(null);
  };

  const removeAssignmentLocally = (type, id) => {
    setLocalAssignments(prev => {
      const newAssignments = JSON.parse(JSON.stringify(prev));

      if (type === 'room') {
        newAssignments.rooms[id] = null;
      } else if (type === 'monitoring') {
        newAssignments.monitoring[id] = null;
      } else if (type === 'checkIn') {
        newAssignments.checkIn[id] = null;
      }

      return newAssignments;
    });

    setHasUnsavedChanges(true);
  };

  const removeQueueEntryLocally = (roomNumber, position) => {
    setLocalQueues(prev => {
      const newQueues = JSON.parse(JSON.stringify(prev));
      newQueues[roomNumber][position - 1] = null;
      return newQueues;
    });

    setHasUnsavedChanges(true);
  };

  const assignUser = async (type, id, user, queuePosition = null) => {
    try {
      if (type === 'queue') {
        // Add to queue
        const response = await fetch('/admin/api/room-queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            roomNumber: id,
            queuePosition: queuePosition,
            userId: user.userid
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to add to queue');
        }

        toast.success(`Added ${user.username} to Room ${id} queue`);
      } else {
        // Regular assignment
        let assignmentType = type;
        if (type === 'checkIn') assignmentType = 'checkin';

        const response = await fetch('/admin/api/room-assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            assignmentType,
            roomNumber: type === 'room' ? id : null,
            position: type !== 'room' ? id + 1 : null,
            userId: user.userid
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to assign user');
        }

        toast.success(`Assigned ${user.username} to ${type} ${type === 'room' ? id : id + 1}`);
      }

      setShowUserSelector(null);
      // The Socket.io event will trigger a refetch
    } catch (err) {
      console.error('Error assigning user:', err);
      toast.error(err.message);
    }
  };

  const removeAssignment = async (assignmentId) => {
    try {
      const response = await fetch(`/admin/api/room-assignments/${assignmentId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove assignment');
      }

      toast.success('Assignment removed');
      // The Socket.io event will trigger a refetch
    } catch (err) {
      console.error('Error removing assignment:', err);
      toast.error(err.message);
    }
  };

  const removeQueueEntry = async (queueId) => {
    try {
      const response = await fetch(`/admin/api/room-queue/${queueId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove from queue');
      }

      toast.success('Removed from queue');
      // The Socket.io event will trigger a refetch
    } catch (err) {
      console.error('Error removing from queue:', err);
      toast.error(err.message);
    }
  };

  // Custom drag and drop handlers
  const registerDropTarget = useCallback((key, element) => {
    if (element) {
      dropTargetsRef.current.set(key, element);
    } else {
      dropTargetsRef.current.delete(key);
    }
  }, []);

  const handleMouseDown = useCallback((e, type, roomNumber, user, queuePosition = null) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();

    setDragState({
      type,
      roomNumber,
      queuePosition,
      user,
      startX: e.clientX,
      startY: e.clientY
    });
    setDragPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!dragState) return;

    const dx = Math.abs(e.clientX - dragState.startX);
    const dy = Math.abs(e.clientY - dragState.startY);

    // Start dragging after moving 5px (prevents accidental drags)
    if (!isDragging && (dx > 5 || dy > 5)) {
      setIsDragging(true);
    }

    if (isDragging) {
      setDragPosition({ x: e.clientX, y: e.clientY });

      // Find drop target under cursor
      let foundTarget = null;
      dropTargetsRef.current.forEach((element, key) => {
        const rect = element.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          const [type, roomNumber, queuePosition] = key.split('-');
          foundTarget = {
            type,
            roomNumber: parseInt(roomNumber),
            queuePosition: queuePosition ? parseInt(queuePosition) : null
          };
        }
      });
      setDropTarget(foundTarget);
    }
  }, [dragState, isDragging]);

  const handleMouseUp = useCallback((e) => {
    if (!dragState) return;

    if (isDragging && dropTarget) {
      // Perform the drop
      const { type: targetType, roomNumber: targetRoom, queuePosition: targetQueuePos } = dropTarget;
      const { type: sourceType, roomNumber: sourceRoom, queuePosition: sourceQueuePos, user } = dragState;

      // Don't drop on same position
      const isSamePosition =
        (targetType === 'room' && sourceType === 'room' && targetRoom === sourceRoom) ||
        (targetType === 'queue' && sourceType === 'queue' && targetRoom === sourceRoom && targetQueuePos === sourceQueuePos);

      if (!isSamePosition) {
        // Assign to new position
        if (targetType === 'room') {
          assignUserLocally('room', targetRoom, user);
        } else if (targetType === 'queue') {
          assignUserLocally('queue', targetRoom, user, targetQueuePos);
        }

        // Remove from source
        if (sourceType === 'room') {
          removeAssignmentLocally('room', sourceRoom);
        } else if (sourceType === 'queue') {
          removeQueueEntryLocally(sourceRoom, sourceQueuePos);
        }
      }
    }

    // Reset drag state
    setDragState(null);
    setDragPosition({ x: 0, y: 0 });
    setDropTarget(null);
    setIsDragging(false);
  }, [dragState, isDragging, dropTarget]);

  // Global mouse event listeners for drag
  useEffect(() => {
    if (dragState) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragState, handleMouseMove, handleMouseUp]);

  const getAssignedUserIds = () => {
    const ids = new Set();
    Object.values(localAssignments.rooms).forEach(user => user && ids.add(user.userid));
    localAssignments.monitoring.forEach(user => user && ids.add(user.userid));
    localAssignments.checkIn.forEach(user => user && ids.add(user.userid));
    Object.values(localQueues).forEach(roomQueue => {
      roomQueue.forEach(user => user && ids.add(user.userid));
    });
    return ids;
  };

  const saveAllChanges = async () => {
    try {
      setLoading(true);

      // First, clear all existing assignments and queues
      const clearPromises = [];

      // Delete all existing room assignments
      Object.values(assignments.rooms).forEach(user => {
        if (user && user.assignment_id) {
          clearPromises.push(
            fetch(`/admin/api/room-assignments/${user.assignment_id}`, {
              method: 'DELETE',
              credentials: 'include'
            })
          );
        }
      });

      // Delete all existing monitoring assignments
      assignments.monitoring.forEach(user => {
        if (user && user.assignment_id) {
          clearPromises.push(
            fetch(`/admin/api/room-assignments/${user.assignment_id}`, {
              method: 'DELETE',
              credentials: 'include'
            })
          );
        }
      });

      // Delete all existing check-in assignments
      assignments.checkIn.forEach(user => {
        if (user && user.assignment_id) {
          clearPromises.push(
            fetch(`/admin/api/room-assignments/${user.assignment_id}`, {
              method: 'DELETE',
              credentials: 'include'
            })
          );
        }
      });

      // Delete all existing queue entries
      Object.values(queues).forEach(roomQueue => {
        roomQueue.forEach(user => {
          if (user && user.queue_id) {
            clearPromises.push(
              fetch(`/admin/api/room-queue/${user.queue_id}`, {
                method: 'DELETE',
                credentials: 'include'
              })
            );
          }
        });
      });

      await Promise.all(clearPromises);

      // Now create all new assignments
      const createPromises = [];

      // Create room assignments
      Object.entries(localAssignments.rooms).forEach(([roomNum, user]) => {
        if (user) {
          createPromises.push(
            fetch('/admin/api/room-assignments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                assignmentType: 'room',
                roomNumber: parseInt(roomNum),
                position: null,
                userId: user.userid
              })
            })
          );
        }
      });

      // Create monitoring assignments
      localAssignments.monitoring.forEach((user, idx) => {
        if (user) {
          createPromises.push(
            fetch('/admin/api/room-assignments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                assignmentType: 'monitoring',
                roomNumber: null,
                position: idx + 1,
                userId: user.userid
              })
            })
          );
        }
      });

      // Create checkin assignments
      localAssignments.checkIn.forEach((user, idx) => {
        if (user) {
          createPromises.push(
            fetch('/admin/api/room-assignments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                assignmentType: 'checkin',
                roomNumber: null,
                position: idx + 1,
                userId: user.userid
              })
            })
          );
        }
      });

      // Create queue entries
      Object.entries(localQueues).forEach(([roomNum, roomQueue]) => {
        roomQueue.forEach((user, idx) => {
          if (user) {
            createPromises.push(
              fetch('/admin/api/room-queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  roomNumber: parseInt(roomNum),
                  queuePosition: idx + 1,
                  userId: user.userid
                })
              })
            );
          }
        });
      });

      await Promise.all(createPromises);

      toast.success('All changes saved successfully!');
      setHasUnsavedChanges(false);

      // Refetch to get the authoritative state from server
      await fetchAssignments();
    } catch (err) {
      console.error('Error saving changes:', err);
      toast.error('Failed to save changes');
    } finally {
      setLoading(false);
    }
  };

  const discardChanges = () => {
    setLocalAssignments(JSON.parse(JSON.stringify(assignments)));
    setLocalQueues(JSON.parse(JSON.stringify(queues)));
    setHasUnsavedChanges(false);
    toast.success('Changes discarded');
  };

  const AssignmentSlot = ({ user, onAssign, onRemove, label, type, showIcon = true, isActive = false, onMouseDown, isDropTarget, isBeingDragged, dropTargetRef }) => {
    return (
      <div
        ref={dropTargetRef}
        onClick={!user && !isBeingDragged ? onAssign : undefined}
        onMouseDown={user ? onMouseDown : undefined}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        className={`relative border-2 rounded-lg p-3 min-h-[80px] transition-all ${
          isDropTarget
            ? 'border-blue-500 bg-blue-100 border-dashed scale-105 ring-2 ring-blue-400'
            : isBeingDragged
              ? 'border-gray-300 bg-gray-100 opacity-50'
              : user
                ? isActive
                  ? 'border-green-500 bg-green-50 hover:bg-green-100 cursor-grab active:cursor-grabbing'
                  : 'border-byuRoyal bg-blue-50 hover:bg-blue-100 cursor-grab active:cursor-grabbing'
                : 'border-dashed border-gray-300 bg-white hover:border-byuRoyal hover:bg-gray-50 cursor-pointer'
        }`}
      >
      {user ? (
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              {showIcon && type === 'participant' && <Users size={16} className="text-byuRoyal" />}
              {showIcon && type === 'researcher' && <Monitor size={16} className="text-green-600" />}
              <span className="font-semibold text-byuNavy text-sm">{user.username}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 capitalize">{user.role}</span>
              {isActive && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-600 text-white text-xs font-semibold rounded">
                  <span className="w-1 h-1 bg-white rounded-full animate-pulse"></span>
                  Active
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-1 hover:bg-red-100 rounded transition text-red-600 z-10 relative"
            aria-label={`Remove ${user.username}`}
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-gray-400">
          <UserPlus size={20} />
          <span className="text-xs">{label}</span>
        </div>
      )}
    </div>
    );
  };

  const QueueSlot = ({ user, onAssign, onRemove, position, onMouseDown, isDropTarget, isBeingDragged, dropTargetRef }) => {
    return (
      <div
        ref={dropTargetRef}
        onClick={!user && !isBeingDragged ? onAssign : undefined}
        onMouseDown={user ? onMouseDown : undefined}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        className={`relative border rounded-lg p-2.5 min-h-[50px] transition-all ${
          isDropTarget
            ? 'border-blue-500 bg-blue-200 border-dashed scale-105 ring-2 ring-blue-400'
            : isBeingDragged
              ? 'border-gray-300 bg-gray-100 opacity-50'
              : user
                ? 'border-blue-300 bg-blue-50 hover:bg-blue-100 cursor-grab active:cursor-grabbing'
                : 'border-dashed border-gray-300 bg-white hover:border-blue-300 hover:bg-gray-50 cursor-pointer'
        }`}
      >
      {user ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-1">
            <Users size={14} className="text-blue-600 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-byuNavy">{user.username}</div>
              <div className="text-xs text-gray-500">Position {position}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="ml-2 p-1 hover:bg-red-100 rounded transition text-red-600 flex-shrink-0 z-10 relative"
            aria-label={`Remove ${user.username}`}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center gap-1.5 text-gray-400 text-xs">
          <UserPlus size={16} />
          <span>Add to Queue</span>
        </div>
      )}
    </div>
    );
  };

  const UserSelectorModal = ({ type, id, queuePosition, allowedUsers, onSelect, onClose }) => (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-byuNavy">
            {type === 'queue' ? `Select Participant for Queue Position ${queuePosition}` :
             type === 'room' ? 'Select Participant' : 'Select Researcher'}
          </h3>
          <button type="button" onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-2">
          {allowedUsers.length === 0 ? (
            <p className="text-gray-500 text-sm italic text-center py-4">
              No {type === 'room' || type === 'queue' ? 'participants' : 'researchers'} available
            </p>
          ) : (
            allowedUsers.map(user => (
              <button
                type="button"
                key={user.userid}
                onClick={() => onSelect(user)}
                className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-byuRoyal hover:bg-blue-50 transition"
              >
                <div className="font-semibold text-byuNavy">{user.username}</div>
                <div className="text-xs text-gray-600 capitalize">{user.role}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const assignedIds = getAssignedUserIds();
  const availableParticipants = participants.filter(p => !assignedIds.has(p.userid));
  const availableResearchers = researchers.filter(r => !assignedIds.has(r.userid));

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center py-8 text-gray-600">Loading room assignments...</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xl font-bold text-byuNavy mb-2">Room & Researcher Assignment</h3>
            <p className="text-gray-600 text-sm">
              Assign participants to rooms and researchers to monitoring/check-in stations
              {connected && <span className="ml-2 text-green-600">● Live</span>}
              {hasUnsavedChanges && <span className="ml-2 text-orange-600 font-semibold">● Unsaved Changes</span>}
            </p>
          </div>
          <div className="flex gap-2">
            {hasUnsavedChanges && (
              <>
                <button
                  type="button"
                  onClick={discardChanges}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition text-sm"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={saveAllChanges}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition text-sm font-semibold"
                >
                  Save Changes
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (hasUnsavedChanges) {
                  if (confirm('You have unsaved changes. Refreshing will discard them. Continue?')) {
                    setHasUnsavedChanges(false);
                    fetchAssignments();
                  }
                } else {
                  fetchAssignments();
                }
              }}
              className="px-3 py-1.5 bg-byuRoyal text-white rounded hover:bg-byuNavy transition text-sm"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Top Row - Check-in and Monitoring */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Left - Check-in Area */}
        <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border-2 border-green-200">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle size={20} className="text-green-700" />
            <h4 className="font-bold text-green-900">Pre-Survey / Check-in</h4>
          </div>
          <div className="text-sm text-green-800 mb-3">~10 sec/participant • 2 users</div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-green-900 mb-1 block">Check-in RA 1</label>
              <AssignmentSlot
                user={localAssignments.checkIn[0]}
                onAssign={() => setShowUserSelector({ type: 'checkIn', id: 0 })}
                onRemove={() => removeAssignmentLocally('checkIn', 0)}
                label="Assign RA"
                type="researcher"
                dragHandlers={{}}
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-green-900 mb-1 block">Check-in RA 2</label>
              <AssignmentSlot
                user={localAssignments.checkIn[1]}
                onAssign={() => setShowUserSelector({ type: 'checkIn', id: 1 })}
                onRemove={() => removeAssignmentLocally('checkIn', 1)}
                label="Assign RA"
                type="researcher"
                dragHandlers={{}}
              />
            </div>
          </div>
        </div>

        {/* Right - Monitoring */}
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4 border-2 border-purple-200">
          <div className="flex items-center gap-2 mb-4">
            <Monitor size={20} className="text-purple-700" />
            <h4 className="font-bold text-purple-900">Monitoring Station</h4>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map(idx => (
              <div key={idx}>
                <label className="text-xs font-semibold text-purple-900 mb-1 block">
                  Monitoring RA {idx + 1}
                </label>
                <AssignmentSlot
                  user={localAssignments.monitoring[idx]}
                  onAssign={() => setShowUserSelector({ type: 'monitoring', id: idx })}
                  onRemove={() => removeAssignmentLocally('monitoring', idx)}
                  label="Assign RA"
                  type="researcher"
                  dragHandlers={{}}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row - Participant Rooms */}
      <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border-2 border-blue-200">
        <div className="flex items-center gap-2 mb-4">
          <Users size={20} className="text-blue-700" />
          <h4 className="font-bold text-blue-900">Participant Rooms</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map(roomNum => {
            const roomUser = localAssignments.rooms[roomNum];
            const isActive = roomUser && activeSessions.has(roomUser.userid);
            const roomQueue = localQueues[roomNum];
            const isRoomBeingDragged = isDragging && dragState?.type === 'room' && dragState?.roomNumber === roomNum;
            const isRoomDropTarget = dropTarget?.type === 'room' && dropTarget?.roomNumber === roomNum;

            return (
              <div key={roomNum} className="bg-white/50 rounded-lg p-3 border border-blue-200">
                <label className="text-xs font-semibold text-blue-900 mb-2 block">
                  Room {roomNum}
                </label>
                <AssignmentSlot
                  user={roomUser}
                  onAssign={() => setShowUserSelector({ type: 'room', id: roomNum })}
                  onRemove={() => removeAssignmentLocally('room', roomNum)}
                  label={`Assign to Room ${roomNum}`}
                  type="participant"
                  isActive={isActive}
                  onMouseDown={(e) => handleMouseDown(e, 'room', roomNum, roomUser)}
                  isDropTarget={isRoomDropTarget && !isRoomBeingDragged}
                  isBeingDragged={isRoomBeingDragged}
                  dropTargetRef={(el) => registerDropTarget(`room-${roomNum}`, el)}
                />

                {/* Queue for this room */}
                <div className="mt-3">
                  <div className="flex items-center gap-1 mb-2">
                    <List size={12} className="text-blue-700" />
                    <span className="text-xs font-semibold text-blue-800">Queue (4 slots)</span>
                  </div>
                  <div className="space-y-2">
                    {roomQueue.map((queueUser, idx) => {
                      const queuePos = idx + 1;
                      const isQueueBeingDragged = isDragging && dragState?.type === 'queue' && dragState?.roomNumber === roomNum && dragState?.queuePosition === queuePos;
                      const isQueueDropTarget = dropTarget?.type === 'queue' && dropTarget?.roomNumber === roomNum && dropTarget?.queuePosition === queuePos;

                      return (
                        <QueueSlot
                          key={idx}
                          user={queueUser}
                          position={queuePos}
                          onAssign={() => setShowUserSelector({ type: 'queue', id: roomNum, queuePosition: queuePos })}
                          onRemove={() => removeQueueEntryLocally(roomNum, queuePos)}
                          onMouseDown={(e) => handleMouseDown(e, 'queue', roomNum, queueUser, queuePos)}
                          isDropTarget={isQueueDropTarget && !isQueueBeingDragged}
                          isBeingDragged={isQueueBeingDragged}
                          dropTargetRef={(el) => registerDropTarget(`queue-${roomNum}-${queuePos}`, el)}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="mt-6 grid grid-cols-4 gap-4">
        <div className="bg-green-50 rounded-lg p-3 border border-green-200">
          <div className="text-xs text-green-700 font-semibold mb-1">Check-in RAs</div>
          <div className="text-2xl font-bold text-green-900">
            {localAssignments.checkIn.filter(Boolean).length} / 2
          </div>
        </div>

        <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
          <div className="text-xs text-blue-700 font-semibold mb-1">Rooms Filled</div>
          <div className="text-2xl font-bold text-blue-900">
            {Object.values(localAssignments.rooms).filter(Boolean).length} / 5
          </div>
        </div>

        <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
          <div className="text-xs text-blue-700 font-semibold mb-1">Active Sessions</div>
          <div className="text-2xl font-bold text-blue-900">
            {activeSessions.size}
          </div>
        </div>

        <div className="bg-purple-50 rounded-lg p-3 border border-purple-200">
          <div className="text-xs text-purple-700 font-semibold mb-1">Monitoring RAs</div>
          <div className="text-2xl font-bold text-purple-900">
            {localAssignments.monitoring.filter(Boolean).length} / 3
          </div>
        </div>
      </div>

      {/* User Selector Modal */}
      {showUserSelector && (
        <UserSelectorModal
          type={showUserSelector.type}
          id={showUserSelector.id}
          queuePosition={showUserSelector.queuePosition}
          allowedUsers={
            showUserSelector.type === 'room' || showUserSelector.type === 'queue'
              ? availableParticipants
              : availableResearchers
          }
          onSelect={(user) => assignUserLocally(showUserSelector.type, showUserSelector.id, user, showUserSelector.queuePosition)}
          onClose={() => setShowUserSelector(null)}
        />
      )}

      {/* Drag Preview */}
      {isDragging && dragState && (
        <div
          className="fixed pointer-events-none z-50 bg-white border-2 border-byuRoyal rounded-lg p-3 shadow-xl opacity-90"
          style={{
            left: dragPosition.x + 10,
            top: dragPosition.y + 10,
            transform: 'translate(0, -50%)'
          }}
        >
          <div className="flex items-center gap-2">
            <Users size={16} className="text-byuRoyal" />
            <span className="font-semibold text-byuNavy text-sm">{dragState.user.username}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {dragState.type === 'room' ? `From Room ${dragState.roomNumber}` : `From Queue ${dragState.roomNumber}-${dragState.queuePosition}`}
          </div>
        </div>
      )}
    </div>
  );
}
