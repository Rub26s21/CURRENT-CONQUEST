/**
 * File Upload Routes for Question Import
 * Supports: Excel (.xlsx, .xls), PDF, Word (.docx), PowerPoint (.pptx)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const { supabase } = require('../config/database');
const { requireAdmin, auditLog } = require('../middleware/auth');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use /tmp for Vercel serverless environment
        const uploadDir = '/tmp';
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
            'application/vnd.ms-excel', // xls
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
            'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
            'application/msword', // doc
            'application/vnd.ms-powerpoint' // ppt
        ];

        const allowedExts = ['.xlsx', '.xls', '.pdf', '.docx', '.doc', '.pptx', '.ppt'];
        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: Excel, PDF, Word, PowerPoint'));
        }
    }
});

/**
 * Parse Excel file for questions
 */
function parseExcel(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);

    const questions = [];

    for (const row of data) {
        // Try different possible column names
        const question = {
            questionText: row['Question'] || row['question'] || row['Question Text'] || row['question_text'] || row['Q'] || '',
            optionA: row['Option A'] || row['option_a'] || row['A'] || row['a'] || '',
            optionB: row['Option B'] || row['option_b'] || row['B'] || row['b'] || '',
            optionC: row['Option C'] || row['option_c'] || row['C'] || row['c'] || '',
            optionD: row['Option D'] || row['option_d'] || row['D'] || row['d'] || '',
            correctOption: (row['Correct'] || row['correct'] || row['Answer'] || row['answer'] || row['Correct Option'] || row['correct_option'] || '').toString().toUpperCase()
        };

        // Only add if question has text
        if (question.questionText && question.questionText.toString().trim()) {
            question.questionText = question.questionText.toString().trim();
            question.optionA = question.optionA.toString().trim();
            question.optionB = question.optionB.toString().trim();
            question.optionC = question.optionC.toString().trim();
            question.optionD = question.optionD.toString().trim();

            // Normalize correct option
            if (question.correctOption.length > 1) {
                question.correctOption = question.correctOption.charAt(0);
            }

            if (['A', 'B', 'C', 'D'].includes(question.correctOption)) {
                questions.push(question);
            }
        }
    }

    return questions;
}

/**
 * Parse PDF file for questions
 * Expected format: Question followed by options A, B, C, D and answer
 */
async function parsePDF(filePath) {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;

    return parseTextContent(text);
}

/**
 * Parse Word document for questions
 */
async function parseWord(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = result.value;

    return parseTextContent(text);
}

/**
 * Parse PowerPoint for questions
 * Note: This is a simplified parser for text content
 */
async function parsePowerPoint(filePath) {
    // For PPTX, we'll use a simpler approach - extract text using mammoth-like parsing
    // or use the AdmZip approach to read the XML content
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    let allText = '';

    for (const entry of zipEntries) {
        if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
            const content = zip.readAsText(entry);
            // Extract text from XML (simplified)
            const textMatches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
            for (const match of textMatches) {
                const text = match.replace(/<a:t>|<\/a:t>/g, '');
                allText += text + '\n';
            }
        }
    }

    return parseTextContent(allText);
}

/**
 * Parse text content to extract questions
 * Supports multiple formats:
 * 1. Q: question A) option B) option C) option D) option Answer: A
 * 2. 1. question a) option b) option c) option d) option Ans: A
 * 3. Question text on line, options on next lines
 */
function parseTextContent(text) {
    const questions = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    let currentQuestion = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if line starts with question number or Q:
        const questionMatch = line.match(/^(?:Q\d*[:.]?\s*|\d+[.)]\s*|Question\s*\d*[:.]?\s*)/i);

        if (questionMatch || (!currentQuestion && line.length > 20 && !line.match(/^[A-Da-d][.)]/))) {
            // New question found
            if (currentQuestion && currentQuestion.questionText && currentQuestion.correctOption) {
                questions.push(currentQuestion);
            }

            currentQuestion = {
                questionText: line.replace(/^(?:Q\d*[:.]?\s*|\d+[.)]\s*|Question\s*\d*[:.]?\s*)/i, '').trim(),
                optionA: '',
                optionB: '',
                optionC: '',
                optionD: '',
                correctOption: ''
            };
        } else if (currentQuestion) {
            // Check for options
            const optionAMatch = line.match(/^[Aa][.)]\s*(.+)/);
            const optionBMatch = line.match(/^[Bb][.)]\s*(.+)/);
            const optionCMatch = line.match(/^[Cc][.)]\s*(.+)/);
            const optionDMatch = line.match(/^[Dd][.)]\s*(.+)/);
            const answerMatch = line.match(/(?:Answer|Ans|Correct)[:\s]*([A-Da-d])/i);

            if (optionAMatch) {
                currentQuestion.optionA = optionAMatch[1].trim();
            } else if (optionBMatch) {
                currentQuestion.optionB = optionBMatch[1].trim();
            } else if (optionCMatch) {
                currentQuestion.optionC = optionCMatch[1].trim();
            } else if (optionDMatch) {
                currentQuestion.optionD = optionDMatch[1].trim();
            } else if (answerMatch) {
                currentQuestion.correctOption = answerMatch[1].toUpperCase();
            } else if (!currentQuestion.optionA && line.length > 0) {
                // Might be continuation of question text
                currentQuestion.questionText += ' ' + line;
            }
        }
    }

    // Add last question if valid
    if (currentQuestion && currentQuestion.questionText && currentQuestion.correctOption) {
        questions.push(currentQuestion);
    }

    return questions;
}

/**
 * POST /api/upload/questions
 * Upload file containing questions
 */
router.post('/questions', requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const roundNumber = parseInt(req.body.roundNumber);

        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                message: 'Invalid round number (must be 1, 2, or 3)'
            });
        }

        // Check if round is already started
        const { data: round } = await supabase
            .from('rounds')
            .select('status')
            .eq('round_number', roundNumber)
            .single();

        if (round && round.status !== 'pending') {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                message: 'Cannot add questions to a round that has already started'
            });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();
        let questions = [];

        try {
            switch (ext) {
                case '.xlsx':
                case '.xls':
                    questions = parseExcel(req.file.path);
                    break;
                case '.pdf':
                    questions = await parsePDF(req.file.path);
                    break;
                case '.docx':
                case '.doc':
                    questions = await parseWord(req.file.path);
                    break;
                case '.pptx':
                case '.ppt':
                    questions = await parsePowerPoint(req.file.path);
                    break;
                default:
                    throw new Error('Unsupported file format');
            }
        } catch (parseError) {
            console.error('Parse error:', parseError);
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                message: `Failed to parse file: ${parseError.message}`
            });
        }

        // Clean up uploaded file
        fs.unlinkSync(req.file.path);

        if (questions.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid questions found in file. Please check the format.'
            });
        }

        // Limit to 15 questions per round
        const questionsToInsert = questions.slice(0, 15).map((q, index) => ({
            round_number: roundNumber,
            question_number: index + 1,
            question_text: q.questionText,
            option_a: q.optionA,
            option_b: q.optionB,
            option_c: q.optionC,
            option_d: q.optionD,
            correct_option: q.correctOption
        }));

        // Validate all questions
        for (let i = 0; i < questionsToInsert.length; i++) {
            const q = questionsToInsert[i];
            if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d) {
                return res.status(400).json({
                    success: false,
                    message: `Question ${i + 1} is missing required fields (question text or options)`
                });
            }
            if (!['A', 'B', 'C', 'D'].includes(q.correct_option)) {
                return res.status(400).json({
                    success: false,
                    message: `Question ${i + 1} has invalid or missing correct answer`
                });
            }
        }

        // Delete existing questions for this round first
        const { error: deleteError } = await supabase
            .from('questions')
            .delete()
            .eq('round_number', roundNumber);

        if (deleteError) {
            console.warn('Delete existing questions warning:', deleteError.message);
        }

        // Insert new questions (use upsert to handle any remaining duplicates)
        const { error } = await supabase
            .from('questions')
            .upsert(questionsToInsert, {
                onConflict: 'round_number,question_number',
                ignoreDuplicates: false
            });

        if (error) throw error;

        auditLog(
            null,
            req.admin.id,
            'QUESTIONS_FILE_UPLOADED',
            `${questionsToInsert.length} questions uploaded from ${req.file.originalname} for Round ${roundNumber}`,
            roundNumber,
            req
        );

        res.json({
            success: true,
            message: `${questionsToInsert.length} questions imported successfully from ${req.file.originalname}`,
            data: {
                totalParsed: questions.length,
                totalImported: questionsToInsert.length,
                questions: questionsToInsert.map((q, i) => ({
                    number: i + 1,
                    preview: q.question_text.substring(0, 50) + (q.question_text.length > 50 ? '...' : ''),
                    correctAnswer: q.correct_option
                }))
            }
        });

    } catch (error) {
        console.error('File upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            message: 'Failed to process uploaded file: ' + error.message
        });
    }
});

/**
 * GET /api/upload/template
 * Download template for questions
 * Query param: format (excel, pdf, word, ppt)
 */
router.get('/template', requireAdmin, async (req, res) => {
    const format = req.query.format || 'excel';

    try {
        if (format === 'excel') {
            const workbook = xlsx.utils.book_new();
            const templateData = [
                {
                    'Question': 'What is the capital of France?',
                    'Option A': 'London',
                    'Option B': 'Paris',
                    'Option C': 'Berlin',
                    'Option D': 'Madrid',
                    'Correct': 'B'
                },
                {
                    'Question': 'Which planet is known as the Red Planet?',
                    'Option A': 'Venus',
                    'Option B': 'Jupiter',
                    'Option C': 'Mars',
                    'Option D': 'Saturn',
                    'Correct': 'C'
                }
            ];

            const worksheet = xlsx.utils.json_to_sheet(templateData);
            xlsx.utils.book_append_sheet(workbook, worksheet, 'Questions');

            // Set column widths
            worksheet['!cols'] = [
                { wch: 50 }, // Question
                { wch: 25 }, // Option A
                { wch: 25 }, // Option B
                { wch: 25 }, // Option C
                { wch: 25 }, // Option D
                { wch: 10 }  // Correct
            ];

            const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=questions_template.xlsx');
            res.send(buffer);

        } else if (format === 'pdf') {
            const PDFDocument = require('pdfkit');
            const doc = new PDFDocument();

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename=questions_template.pdf');

            doc.pipe(res);

            doc.fontSize(20).text('Question Import Format', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text('You can upload questions in PDF format using the following structure:');
            doc.moveDown();

            doc.font('Helvetica-Bold').text('Example 1 (Numbered with Options):');
            doc.font('Helvetica').text('1. What is the capital of France?');
            doc.text('a) London');
            doc.text('b) Paris');
            doc.text('c) Berlin');
            doc.text('d) Madrid');
            doc.text('Ans: B');
            doc.moveDown();

            doc.font('Helvetica-Bold').text('Example 2 (Q/A format):');
            doc.font('Helvetica').text('Q: Which planet is known as the Red Planet?');
            doc.text('A) Venus');
            doc.text('B) Jupiter');
            doc.text('C) Mars');
            doc.text('D) Saturn');
            doc.text('Answer: C');
            doc.moveDown();

            doc.text('Note: Ensure each question has 4 options and a clear answer key.');
            doc.end();

        } else if (format === 'word') {
            const { Document, Packer, Paragraph, TextRun } = require('docx');

            const doc = new Document({
                sections: [{
                    properties: {},
                    children: [
                        new Paragraph({
                            children: [new TextRun({ text: "Question Import Template", bold: true, size: 32 })],
                            spacing: { after: 200 }
                        }),
                        new Paragraph({
                            children: [new TextRun("1. What is the capital of France?")],
                            spacing: { before: 100 }
                        }),
                        new Paragraph({ children: [new TextRun("a) London")] }),
                        new Paragraph({ children: [new TextRun("b) Paris")] }),
                        new Paragraph({ children: [new TextRun("c) Berlin")] }),
                        new Paragraph({ children: [new TextRun("d) Madrid")] }),
                        new Paragraph({ children: [new TextRun("Ans: B")] }),

                        new Paragraph({
                            children: [new TextRun("2. Which planet is known as the Red Planet?")],
                            spacing: { before: 200 }
                        }),
                        new Paragraph({ children: [new TextRun("A) Venus")] }),
                        new Paragraph({ children: [new TextRun("B) Jupiter")] }),
                        new Paragraph({ children: [new TextRun("C) Mars")] }),
                        new Paragraph({ children: [new TextRun("D) Saturn")] }),
                        new Paragraph({ children: [new TextRun("Answer: C")] }),
                    ],
                }],
            });

            const buffer = await Packer.toBuffer(doc);

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', 'attachment; filename=questions_template.docx');
            res.send(buffer);

        } else if (format === 'ppt') {
            const PptxGenJS = require('pptxgenjs');
            const pptx = new PptxGenJS();

            let slide = pptx.addSlide();
            slide.addText('Question Import Template', { x: 1, y: 1, fontSize: 24, color: '363636' });
            slide.addText('1. What is the capital of France?\na) London\nb) Paris\nc) Berlin\nd) Madrid\nAns: B', {
                x: 1, y: 2.5, fontSize: 18, color: '363636', h: 3
            });

            let slide2 = pptx.addSlide();
            slide2.addText('2. Which planet is known as the Red Planet?\nA) Venus\nB) Jupiter\nC) Mars\nD) Saturn\nAnswer: C', {
                x: 1, y: 1, fontSize: 18, color: '363636'
            });

            const buffer = await pptx.write({ outputType: 'nodebuffer' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
            res.setHeader('Content-Disposition', 'attachment; filename=questions_template.pptx');
            res.send(buffer);

        } else {
            res.status(400).send('Invalid format');
        }

    } catch (error) {
        console.error('Template generation error:', error);
        res.status(500).send('Failed to generate template');
    }
});

module.exports = router;
