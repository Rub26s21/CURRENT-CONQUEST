/**
 * Question Management Routes
 * Current Conquest - ECE Professional Online Exam Platform
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { requireAdmin, auditLog } = require('../middleware/auth');

/**
 * POST /api/questions/add
 * Add a new question
 */
router.post('/add', requireAdmin, async (req, res) => {
    try {
        const {
            roundNumber,
            questionNumber,
            questionText,
            optionA,
            optionB,
            optionC,
            optionD,
            correctOption
        } = req.body;

        // Validation
        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            return res.status(400).json({
                success: false,
                message: 'Invalid round number (must be 1, 2, or 3)'
            });
        }

        if (!questionNumber || questionNumber < 1 || questionNumber > 15) {
            return res.status(400).json({
                success: false,
                message: 'Invalid question number (must be 1-15)'
            });
        }

        if (!questionText || !optionA || !optionB || !optionC || !optionD) {
            return res.status(400).json({
                success: false,
                message: 'Question text and all options are required'
            });
        }

        if (!correctOption || !['A', 'B', 'C', 'D'].includes(correctOption.toUpperCase())) {
            return res.status(400).json({
                success: false,
                message: 'Valid correct option (A, B, C, or D) is required'
            });
        }

        // Check if round is already started
        const { data: round } = await supabase
            .from('rounds')
            .select('status')
            .eq('round_number', roundNumber)
            .single();

        if (round && round.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Cannot add questions to a round that has already started'
            });
        }

        // Check if question number already exists for this round
        const { data: existingQuestion } = await supabase
            .from('questions')
            .select('id')
            .eq('round_number', roundNumber)
            .eq('question_number', questionNumber)
            .single();

        if (existingQuestion) {
            // Update existing question
            const { error } = await supabase
                .from('questions')
                .update({
                    question_text: questionText.trim(),
                    option_a: optionA.trim(),
                    option_b: optionB.trim(),
                    option_c: optionC.trim(),
                    option_d: optionD.trim(),
                    correct_option: correctOption.toUpperCase()
                })
                .eq('id', existingQuestion.id);

            if (error) throw error;

            await auditLog(
                null,
                req.admin.id,
                'QUESTION_UPDATED',
                `Question ${questionNumber} updated for Round ${roundNumber}`,
                roundNumber,
                req
            );

            return res.json({
                success: true,
                message: 'Question updated successfully'
            });
        }

        // Insert new question
        const { error } = await supabase
            .from('questions')
            .insert({
                round_number: roundNumber,
                question_number: questionNumber,
                question_text: questionText.trim(),
                option_a: optionA.trim(),
                option_b: optionB.trim(),
                option_c: optionC.trim(),
                option_d: optionD.trim(),
                correct_option: correctOption.toUpperCase()
            });

        if (error) throw error;

        await auditLog(
            null,
            req.admin.id,
            'QUESTION_ADDED',
            `Question ${questionNumber} added for Round ${roundNumber}`,
            roundNumber,
            req
        );

        res.json({
            success: true,
            message: 'Question added successfully'
        });
    } catch (error) {
        console.error('Add question error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add question'
        });
    }
});

/**
 * GET /api/questions/round/:roundNumber
 * Get all questions for a round (admin only, includes correct answers)
 */
router.get('/round/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            return res.status(400).json({
                success: false,
                message: 'Invalid round number'
            });
        }

        const { data: questions, error } = await supabase
            .from('questions')
            .select('*')
            .eq('round_number', roundNumber)
            .order('question_number');

        if (error) throw error;

        res.json({
            success: true,
            data: questions || []
        });
    } catch (error) {
        console.error('Fetch questions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch questions'
        });
    }
});

/**
 * DELETE /api/questions/:questionId
 * Delete a question
 */
router.delete('/:questionId', requireAdmin, async (req, res) => {
    try {
        const { questionId } = req.params;

        // Get question details first
        const { data: question } = await supabase
            .from('questions')
            .select('round_number, question_number')
            .eq('id', questionId)
            .single();

        if (!question) {
            return res.status(404).json({
                success: false,
                message: 'Question not found'
            });
        }

        // Check if round is already started
        const { data: round } = await supabase
            .from('rounds')
            .select('status')
            .eq('round_number', question.round_number)
            .single();

        if (round && round.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete questions from a round that has already started'
            });
        }

        const { error } = await supabase
            .from('questions')
            .delete()
            .eq('id', questionId);

        if (error) throw error;

        await auditLog(
            null,
            req.admin.id,
            'QUESTION_DELETED',
            `Question ${question.question_number} deleted from Round ${question.round_number}`,
            question.round_number,
            req
        );

        res.json({
            success: true,
            message: 'Question deleted successfully'
        });
    } catch (error) {
        console.error('Delete question error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete question'
        });
    }
});

/**
 * POST /api/questions/bulk-add
 * Bulk add questions from JSON
 */
router.post('/bulk-add', requireAdmin, async (req, res) => {
    try {
        const { roundNumber, questions } = req.body;

        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            return res.status(400).json({
                success: false,
                message: 'Invalid round number'
            });
        }

        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Questions array is required'
            });
        }

        // Check if round is already started
        const { data: round } = await supabase
            .from('rounds')
            .select('status')
            .eq('round_number', roundNumber)
            .single();

        if (round && round.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Cannot add questions to a round that has already started'
            });
        }

        // Delete existing questions for this round
        await supabase
            .from('questions')
            .delete()
            .eq('round_number', roundNumber);

        // Prepare questions for insertion
        const questionsToInsert = questions.slice(0, 15).map((q, index) => ({
            round_number: roundNumber,
            question_number: index + 1,
            question_text: q.questionText?.trim() || q.question_text?.trim(),
            option_a: q.optionA?.trim() || q.option_a?.trim(),
            option_b: q.optionB?.trim() || q.option_b?.trim(),
            option_c: q.optionC?.trim() || q.option_c?.trim(),
            option_d: q.optionD?.trim() || q.option_d?.trim(),
            correct_option: (q.correctOption || q.correct_option || '').toUpperCase()
        }));

        // Validate all questions
        for (let i = 0; i < questionsToInsert.length; i++) {
            const q = questionsToInsert[i];
            if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d) {
                return res.status(400).json({
                    success: false,
                    message: `Question ${i + 1} is missing required fields`
                });
            }
            if (!['A', 'B', 'C', 'D'].includes(q.correct_option)) {
                return res.status(400).json({
                    success: false,
                    message: `Question ${i + 1} has invalid correct option`
                });
            }
        }

        const { error } = await supabase
            .from('questions')
            .insert(questionsToInsert);

        if (error) throw error;

        await auditLog(
            null,
            req.admin.id,
            'QUESTIONS_BULK_ADDED',
            `${questionsToInsert.length} questions bulk added for Round ${roundNumber}`,
            roundNumber,
            req
        );

        res.json({
            success: true,
            message: `${questionsToInsert.length} questions added successfully`
        });
    } catch (error) {
        console.error('Bulk add error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add questions'
        });
    }
});

module.exports = router;
