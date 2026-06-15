import { pool } from '../config/db.js';
import { logInterventionAction } from './crisisDetection.service.js';

// ============================================
// HUMAN HANDOFF WORKFLOWS
// ============================================

/**
 * Initiate handoff to human clinician or crisis service
 * @param {string} sessionId - Session ID
 * @param {number} riskScore - Risk score
 * @param {string} handoffType - Type of handoff (default: crisis_hotline)
 * @returns {object} Handoff record
 */
export async function initiateHumanHandoff(sessionId, riskScore, handoffType = 'crisis_hotline') {
  try {
    // 1. Create handoff record
    const handoffRecord = await pool.query(
      `INSERT INTO human_handoffs
       (session_id, risk_score, handoff_type, status, initiated_at, initiated_by)
       VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP, 'system')
       RETURNING *`,
      [sessionId, riskScore, handoffType]
    );

    const handoff = handoffRecord.rows[0];

    // 2. Notify admins to facilitate handoff
    if (global.io) {
      global.io.to('admin-broadcast').emit('session:handoff-required', {
        sessionId,
        riskScore,
        handoffId: handoff.handoff_id,
        handoffType,
        message: `Human handoff initiated - ${handoffType} - Admin action required`,
        initiatedAt: handoff.initiated_at
      });
    }

    // 3. Log intervention action
    await logInterventionAction(sessionId, 'handoff_initiated', {
      handoffId: handoff.handoff_id,
      riskScore,
      handoffType
    });

    // 4. Create clinical review request for high-risk cases
    if (riskScore >= 70) {
      await flagForClinicalReview(
        sessionId,
        riskScore,
        `High-risk crisis detected (score: ${riskScore}) - Post-incident review required`
      );
    }

    console.log(`Human handoff initiated for session ${sessionId} - Handoff ID: ${handoff.handoff_id}`);

    return handoff;
  } catch (error) {
    console.error('Error initiating human handoff:', error);
    throw error;
  }
}

/**
 * Update handoff status
 * @param {number} handoffId - Handoff ID
 * @param {string} status - New status (in_progress, completed, cancelled)
 * @param {string} assignedTo - Person assigned to handle handoff
 * @param {string} notes - Additional notes
 */
export async function updateHandoffStatus(handoffId, status, assignedTo = null, notes = null) {
  try {
    const updates = ['status = $2'];
    const params = [handoffId, status];
    let paramIndex = 3;

    if (assignedTo) {
      updates.push(`assigned_to = $${paramIndex}`);
      params.push(assignedTo);
      paramIndex++;
    }

    if (status === 'completed') {
      updates.push(`completed_at = CURRENT_TIMESTAMP`);
    }

    if (notes) {
      updates.push(`notes = $${paramIndex}`);
      params.push(notes);
      paramIndex++;
    }

    const query = `
      UPDATE human_handoffs
      SET ${updates.join(', ')}
      WHERE handoff_id = $1
      RETURNING *
    `;

    const result = await pool.query(query, params);

    // Emit update to admins
    if (global.io && result.rows[0]) {
      const handoff = result.rows[0];
      global.io.to('admin-broadcast').emit('handoff:status-updated', {
        handoffId,
        sessionId: handoff.session_id,
        status,
        assignedTo,
        updatedAt: new Date()
      });
    }

    console.log(`Handoff ${handoffId} status updated to: ${status}`);

    return result.rows[0];
  } catch (error) {
    console.error('Error updating handoff status:', error);
    throw error;
  }
}

/**
 * Get handoffs for a session
 * @param {string} sessionId - Session ID
 * @returns {array} Handoff records
 */
export async function getSessionHandoffs(sessionId) {
  try {
    const result = await pool.query(
      `SELECT * FROM human_handoffs
       WHERE session_id = $1
       ORDER BY initiated_at DESC`,
      [sessionId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting session handoffs:', error);
    return [];
  }
}

/**
 * Get pending handoffs
 * @returns {array} Pending handoff records
 */
export async function getPendingHandoffs() {
  try {
    const result = await pool.query(
      `SELECT
         hh.*,
         ts.session_name,
         u.username
       FROM human_handoffs hh
       LEFT JOIN therapy_sessions ts ON hh.session_id = ts.session_id
       LEFT JOIN users u ON ts.user_id = u.userid
       WHERE hh.status = 'pending'
       ORDER BY hh.risk_score DESC, hh.initiated_at ASC`
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting pending handoffs:', error);
    return [];
  }
}

// ============================================
// CLINICAL REVIEW WORKFLOWS
// ============================================

/**
 * Flag session for clinical review
 * @param {string} sessionId - Session ID
 * @param {number} riskScore - Risk score
 * @param {string} reviewReason - Reason for review
 * @param {string} reviewType - Type of review (default: post_crisis)
 */
export async function flagForClinicalReview(sessionId, riskScore, reviewReason, reviewType = 'post_crisis') {
  try {
    const result = await pool.query(
      `INSERT INTO clinical_reviews
       (session_id, risk_score, review_reason, review_type, status, requested_at, requested_by)
       VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP, 'system')
       RETURNING *`,
      [sessionId, riskScore, reviewReason, reviewType]
    );

    const review = result.rows[0];

    // Notify researchers/therapists
    if (global.io) {
      global.io.to('admin-broadcast').emit('session:clinical-review-required', {
        sessionId,
        riskScore,
        reviewReason,
        reviewType,
        reviewId: review.review_id,
        priority: riskScore > 70 ? 'critical' : 'high',
        requestedAt: review.requested_at
      });
    }

    console.log(`Clinical review requested for session ${sessionId} - Review ID: ${review.review_id}`);

    return review;
  } catch (error) {
    console.error('Error flagging for clinical review:', error);
    throw error;
  }
}

/**
 * Update clinical review
 * @param {number} reviewId - Review ID
 * @param {string} status - New status
 * @param {object} data - Review data (assignedTo, findings, recommendations, complianceStatus)
 */
export async function updateClinicalReview(reviewId, status, data = {}) {
  try {
    const updates = ['status = $2'];
    const params = [reviewId, status];
    let paramIndex = 3;

    if (data.assignedTo) {
      updates.push(`assigned_to = $${paramIndex}`);
      params.push(data.assignedTo);
      paramIndex++;
    }

    if (status === 'completed') {
      updates.push(`reviewed_at = CURRENT_TIMESTAMP`);
    }

    if (data.findings) {
      updates.push(`review_findings = $${paramIndex}`);
      params.push(data.findings);
      paramIndex++;
    }

    if (data.recommendations) {
      updates.push(`recommendations = $${paramIndex}`);
      params.push(data.recommendations);
      paramIndex++;
    }

    if (data.complianceStatus) {
      updates.push(`compliance_status = $${paramIndex}`);
      params.push(data.complianceStatus);
      paramIndex++;
    }

    const query = `
      UPDATE clinical_reviews
      SET ${updates.join(', ')}
      WHERE review_id = $1
      RETURNING *
    `;

    const result = await pool.query(query, params);

    // Emit update to admins
    if (global.io && result.rows[0]) {
      const review = result.rows[0];
      global.io.to('admin-broadcast').emit('clinical-review:updated', {
        reviewId,
        sessionId: review.session_id,
        status,
        updatedAt: new Date()
      });
    }

    console.log(`Clinical review ${reviewId} updated - Status: ${status}`);

    return result.rows[0];
  } catch (error) {
    console.error('Error updating clinical review:', error);
    throw error;
  }
}

/**
 * Get pending clinical reviews
 * @returns {array} Pending review records
 */
export async function getPendingClinicalReviews() {
  try {
    const result = await pool.query(
      `SELECT
         cr.*,
         ts.session_name,
         u.username
       FROM clinical_reviews cr
       LEFT JOIN therapy_sessions ts ON cr.session_id = ts.session_id
       LEFT JOIN users u ON ts.user_id = u.userid
       WHERE cr.status = 'pending'
       ORDER BY cr.risk_score DESC, cr.requested_at ASC`
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting pending clinical reviews:', error);
    return [];
  }
}

/**
 * Get session clinical reviews
 * @param {string} sessionId - Session ID
 * @returns {array} Clinical review records
 */
export async function getSessionClinicalReviews(sessionId) {
  try {
    const result = await pool.query(
      `SELECT * FROM clinical_reviews
       WHERE session_id = $1
       ORDER BY requested_at DESC`,
      [sessionId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting session clinical reviews:', error);
    return [];
  }
}

// ============================================
// EXTERNAL API INTEGRATION (Future Enhancement)
// ============================================

/**
 * Trigger external handoff API (placeholder for future implementation)
 * @param {string} sessionId - Session ID
 * @param {number} riskScore - Risk score
 */
export async function triggerExternalHandoffAPI(sessionId, riskScore) {
  // Placeholder for future integration with crisis services
  // Example: Crisis Text Line API, 988 Lifeline API
  try {
    console.log(`[PLACEHOLDER] External API handoff for session ${sessionId} (risk: ${riskScore})`);

    // When implemented:
    // const response = await fetch('https://api.crisisservice.org/referral', {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': `Bearer ${process.env.CRISIS_API_KEY}`
    //   },
    //   body: JSON.stringify({
    //     sessionId,
    //     riskLevel: riskScore,
    //     timestamp: new Date(),
    //     urgency: riskScore > 70 ? 'critical' : 'high'
    //   })
    // });

    // if (response.ok) {
    //   const data = await response.json();
    //   await logInterventionAction(sessionId, 'external_api_called', {
    //     apiResponse: data,
    //     provider: 'crisis_hotline_api'
    //   });
    //   return data;
    // }

    return { status: 'placeholder', message: 'External API integration not yet implemented' };
  } catch (error) {
    console.error('Error triggering external API:', error);
    // Fallback: Continue with internal handoff process
    return null;
  }
}
