import { Router } from 'express';
import { pool } from '../../config/db.js';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('admin:rooms');

/**
 * Handle room cleanup when a session ends.
 * Removes room assignment and promotes next person from queue.
 */
export async function handleSessionEndRoomCleanup(sessionId) {
  try {
    const sessionResult = await pool.query(
      'SELECT user_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return;
    }

    const userId = sessionResult.rows[0].user_id;
    if (!userId) {
      return;
    }

    const assignmentResult = await pool.query(
      `SELECT assignment_id, room_number
       FROM room_assignments
       WHERE user_id = $1 AND assignment_type = 'room'`,
      [userId]
    );

    if (assignmentResult.rows.length === 0) {
      return;
    }

    const assignment = assignmentResult.rows[0];
    const roomNumber = assignment.room_number;

    log.info({ userId, roomNumber, sessionId }, 'Session ended, promoting queue');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM room_assignments WHERE assignment_id = $1',
        [assignment.assignment_id]
      );

      const queueResult = await client.query(
        `SELECT * FROM room_queue
         WHERE room_number = $1
         ORDER BY queue_position
         LIMIT 1`,
        [roomNumber]
      );

      if (queueResult.rows.length > 0) {
        const firstInQueue = queueResult.rows[0];

        const newAssignmentResult = await client.query(
          `INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
           VALUES ('room', $1, NULL, $2)
           RETURNING *`,
          [roomNumber, firstInQueue.user_id]
        );

        await client.query(
          'DELETE FROM room_queue WHERE queue_id = $1',
          [firstInQueue.queue_id]
        );

        const userResult = await client.query(
          'SELECT userid, username, role FROM users WHERE userid = $1',
          [firstInQueue.user_id]
        );

        const user = userResult.rows[0];
        const newAssignment = newAssignmentResult.rows[0];

        await client.query('COMMIT');

        global.io.to('admin-broadcast').emit('room-assignment:removed', {
          assignmentId: assignment.assignment_id
        });

        global.io.to('admin-broadcast').emit('room-assignment:updated', {
          assignment: {
            ...newAssignment,
            username: user.username,
            role: user.role
          }
        });

        global.io.to('admin-broadcast').emit('room-queue:removed', {
          queueId: firstInQueue.queue_id
        });

        log.info({ userId: firstInQueue.user_id, username: user.username, roomNumber }, 'Auto-promoted from queue to room');
      } else {
        await client.query('COMMIT');

        global.io.to('admin-broadcast').emit('room-assignment:removed', {
          assignmentId: assignment.assignment_id
        });

        log.info({ roomNumber }, 'Room is now empty (no queue)');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({ err }, 'Failed to handle room cleanup');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    log.error({ err, sessionId }, 'Error in handleSessionEndRoomCleanup');
    // Don't throw - we don't want to break session ending if room cleanup fails
  }
}

export default function adminRoomsRoutes() {
  const router = Router();

  // GET /admin/api/room-assignments
  router.get('/admin/api/room-assignments', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching room assignments and queues');

    const assignmentsResult = await pool.query(`
      SELECT
        ra.assignment_id,
        ra.assignment_type,
        ra.room_number,
        ra.position,
        ra.user_id,
        u.username,
        u.role,
        ra.created_at,
        ra.updated_at
      FROM room_assignments ra
      LEFT JOIN users u ON ra.user_id = u.userid
      ORDER BY ra.assignment_type, ra.room_number, ra.position
    `);

    const queueResult = await pool.query(`
      SELECT
        rq.queue_id,
        rq.room_number,
        rq.queue_position,
        rq.user_id,
        u.username,
        u.role,
        rq.created_at
      FROM room_queue rq
      LEFT JOIN users u ON rq.user_id = u.userid
      ORDER BY rq.room_number, rq.queue_position
    `);

    const activeSessionsResult = await pool.query(`
      SELECT
        ts.user_id,
        ts.session_id,
        ts.created_at as session_started
      FROM therapy_sessions ts
      WHERE ts.status = 'active'
    `);

    res.json({
      assignments: assignmentsResult.rows,
      queue: queueResult.rows,
      activeSessions: activeSessionsResult.rows
    });
  }));

  // POST /admin/api/room-assignments
  router.post('/admin/api/room-assignments', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { assignmentType, roomNumber, position, userId } = req.body;

    if (!assignmentType || !userId) {
      return res.status(400).json({ error: "assignmentType and userId are required" });
    }

    if (assignmentType === 'room' && (!roomNumber || roomNumber < 1 || roomNumber > 5)) {
      return res.status(400).json({ error: "Valid room number (1-5) is required for room assignments" });
    }

    if (assignmentType === 'monitoring' && (!position || position < 1 || position > 3)) {
      return res.status(400).json({ error: "Valid position (1-3) is required for monitoring assignments" });
    }

    if (assignmentType === 'checkin' && (!position || position < 1 || position > 2)) {
      return res.status(400).json({ error: "Valid position (1-2) is required for checkin assignments" });
    }

    const userResult = await pool.query('SELECT userid, username, role FROM users WHERE userid = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    if (assignmentType === 'room' && user.role !== 'participant') {
      return res.status(400).json({ error: "Only participants can be assigned to rooms" });
    }

    if ((assignmentType === 'monitoring' || assignmentType === 'checkin') && user.role !== 'researcher') {
      return res.status(400).json({ error: "Only researchers can be assigned to monitoring/checkin stations" });
    }

    // Remove user from any existing assignments first
    await pool.query('DELETE FROM room_assignments WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM room_queue WHERE user_id = $1', [userId]);

    const result = await pool.query(`
      INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (assignment_type, room_number, position)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      assignmentType,
      assignmentType === 'room' ? roomNumber : null,
      assignmentType !== 'room' ? position : null,
      userId
    ]);

    const assignment = result.rows[0];

    global.io.to('admin-broadcast').emit('room-assignment:updated', {
      assignment: {
        ...assignment,
        username: user.username,
        role: user.role
      }
    });

    log.info({ adminUsername: req.session.username, username: user.username, assignmentType, roomNumber, position }, 'Room assignment created');

    res.json({
      assignment: {
        ...assignment,
        username: user.username,
        role: user.role
      }
    });
  }));

  // DELETE /admin/api/room-assignments/:assignmentId
  router.delete('/admin/api/room-assignments/:assignmentId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { assignmentId } = req.params;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        'DELETE FROM room_assignments WHERE assignment_id = $1 RETURNING *',
        [assignmentId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "Assignment not found" });
      }

      const deletedAssignment = result.rows[0];

      if (deletedAssignment.assignment_type === 'room' && deletedAssignment.room_number) {
        const roomNumber = deletedAssignment.room_number;

        const queueResult = await client.query(
          `SELECT * FROM room_queue
           WHERE room_number = $1
           ORDER BY queue_position
           LIMIT 1`,
          [roomNumber]
        );

        if (queueResult.rows.length > 0) {
          const firstInQueue = queueResult.rows[0];

          const newAssignmentResult = await client.query(
            `INSERT INTO room_assignments (assignment_type, room_number, position, user_id)
             VALUES ('room', $1, NULL, $2)
             RETURNING *`,
            [roomNumber, firstInQueue.user_id]
          );

          await client.query(
            'DELETE FROM room_queue WHERE queue_id = $1',
            [firstInQueue.queue_id]
          );

          const userResult = await client.query(
            'SELECT userid, username, role FROM users WHERE userid = $1',
            [firstInQueue.user_id]
          );

          const user = userResult.rows[0];
          const newAssignment = newAssignmentResult.rows[0];

          await client.query('COMMIT');

          global.io.to('admin-broadcast').emit('room-assignment:removed', {
            assignmentId: parseInt(assignmentId)
          });

          global.io.to('admin-broadcast').emit('room-assignment:updated', {
            assignment: {
              ...newAssignment,
              username: user.username,
              role: user.role
            }
          });

          global.io.to('admin-broadcast').emit('room-queue:removed', {
            queueId: firstInQueue.queue_id
          });

          log.info({ adminUsername: req.session.username, assignmentId, promotedUser: user.username, roomNumber }, 'Assignment removed, user promoted');

          return res.json({
            message: "Assignment removed successfully",
            promoted: {
              username: user.username,
              roomNumber: roomNumber
            }
          });
        }
      }

      await client.query('COMMIT');

      global.io.to('admin-broadcast').emit('room-assignment:removed', {
        assignmentId: parseInt(assignmentId)
      });

      log.info({ adminUsername: req.session.username, assignmentId }, 'Assignment removed');

      res.json({ message: "Assignment removed successfully" });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));

  // POST /admin/api/room-queue
  router.post('/admin/api/room-queue', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { roomNumber, queuePosition, userId } = req.body;

    if (!roomNumber || roomNumber < 1 || roomNumber > 5) {
      return res.status(400).json({ error: "Valid room number (1-5) is required" });
    }

    if (!queuePosition || queuePosition < 1 || queuePosition > 4) {
      return res.status(400).json({ error: "Valid queue position (1-4) is required" });
    }

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const userResult = await pool.query('SELECT userid, username, role FROM users WHERE userid = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];

    if (user.role !== 'participant') {
      return res.status(400).json({ error: "Only participants can be added to room queues" });
    }

    // Remove user from any existing queue positions or room assignments
    await pool.query('DELETE FROM room_queue WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM room_assignments WHERE user_id = $1', [userId]);

    const result = await pool.query(`
      INSERT INTO room_queue (room_number, queue_position, user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (room_number, queue_position)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        created_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [roomNumber, queuePosition, userId]);

    const queueEntry = result.rows[0];

    global.io.to('admin-broadcast').emit('room-queue:updated', {
      queueEntry: {
        ...queueEntry,
        username: user.username,
        role: user.role
      }
    });

    log.info({ adminUsername: req.session.username, username: user.username, roomNumber, queuePosition }, 'Added to queue');

    res.json({
      queueEntry: {
        ...queueEntry,
        username: user.username,
        role: user.role
      }
    });
  }));

  // DELETE /admin/api/room-queue/:queueId
  router.delete('/admin/api/room-queue/:queueId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { queueId } = req.params;

    const result = await pool.query(
      'DELETE FROM room_queue WHERE queue_id = $1 RETURNING *',
      [queueId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Queue entry not found" });
    }

    global.io.to('admin-broadcast').emit('room-queue:removed', {
      queueId: parseInt(queueId)
    });

    log.info({ adminUsername: req.session.username, queueId }, 'Removed from queue');

    res.json({ message: "Queue entry removed successfully" });
  }));

  return router;
}
