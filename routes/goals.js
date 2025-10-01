const express = require('express');
const router = express.Router();
const Goal = require('../models/Goal');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const axios = require('axios');

// Enhanced middleware to verify JWT token
const verifyToken = (req, res, next) => {
    const authHeader = req.header('Authorization');
    const token = authHeader?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified.user;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

// Input validation for goal creation
const validateGoalCreation = (req, res, next) => {
    const { title, depositAmount } = req.body;
    
    if (!title || title.trim().length < 5) {
        return res.status(400).json({ message: 'Goal title must be at least 5 characters long' });
    }
    
    if (!depositAmount || depositAmount < 1 || depositAmount > 10000) {
        return res.status(400).json({ message: 'Deposit amount must be between $1 and $10,000' });
    }
    
    next();
};

// Enhanced Gemini API function using axios
const callGeminiAPI = async (prompt) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        throw new Error('Gemini API key is not configured');
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "milestones": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "description": { 
                                    "type": "STRING",
                                    "minLength": 20,
                                    "maxLength": 400
                                },
                                "verificationCriteria": {
                                    "type": "STRING",
                                    "minLength": 20,
                                    "maxLength": 400
                                },
                                "requiredProofType": {
                                    "type": "STRING",
                                    "enum": ["image", "video", "document", "text", "any"]
                                },
                                "percentage": { 
                                    "type": "NUMBER",
                                    "minimum": 5,
                                    "maximum": 50
                                }
                            },
                            "required": ["description", "verificationCriteria", "requiredProofType", "percentage"]
                        },
                        "minItems": 4,
                        "maxItems": 6
                    }
                },
                "required": ["milestones"]
            },
            "temperature": 0.8,
            "topP": 0.9,
            "topK": 40
        },
    };

    try {
        console.log('Sending request to Gemini API...');
        
        const response = await axios.post(apiUrl, payload, {
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'AI-Escrow-App/1.0'
            },
            timeout: 30000
        });
        
        console.log('Gemini API Response Status:', response.status);
        const result = response.data;
        
        const contentPart = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!contentPart) {
            console.error('Empty response from Gemini API:', result);
            throw new Error("Gemini API response was empty or malformed");
        }
        
        const parsedContent = JSON.parse(contentPart);
        
        if (!parsedContent.milestones || !Array.isArray(parsedContent.milestones)) {
            throw new Error("Invalid milestone structure in AI response");
        }
        
        const totalPercentage = parsedContent.milestones.reduce((sum, milestone) => sum + milestone.percentage, 0);
        console.log('Total percentage:', totalPercentage);
        
        if (Math.abs(totalPercentage - 100) > 5) {
            console.log('Normalizing percentages from', totalPercentage, 'to 100');
            const factor = 100 / totalPercentage;
            parsedContent.milestones.forEach(milestone => {
                milestone.percentage = Math.round(milestone.percentage * factor * 100) / 100;
            });
        }
        
        parsedContent.milestones.forEach((milestone, index) => {
            if (!milestone.description || milestone.description.length < 20) {
                throw new Error(`Milestone ${index + 1} description is too short or empty`);
            }
            if (milestone.percentage < 5 || milestone.percentage > 50) {
                throw new Error(`Milestone ${index + 1} percentage is out of valid range`);
            }
        });
        
        console.log('Successfully validated AI-generated milestones');
        return parsedContent;
        
    } catch (error) {
        if (error.response) {
            console.error("Gemini API Response Error:", error.response.status, error.response.data);
            throw new Error(`Gemini API error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error("Gemini API Network Error:", error.message);
            throw new Error(`Network error calling Gemini API: ${error.message}`);
        } else {
            console.error("Gemini API Error Details:", error.message);
            throw error;
        }
    }
};

// Function to verify milestone completion using Gemini API
const verifyMilestoneWithAI = async (milestone, proofUrl, proofDescription) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        throw new Error('Gemini API key is not configured');
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    const prompt = `You are an AI verification assistant for a goal achievement platform. 

MILESTONE TO VERIFY:
"${milestone.description}"

VERIFICATION CRITERIA:
"${milestone.verificationCriteria}"

USER'S PROOF:
${proofDescription || 'User provided visual proof (see image/video)'}

YOUR TASK:
Analyze whether the proof provided demonstrates genuine completion of this milestone according to the verification criteria.

Respond with a JSON object containing:
{
  "verified": true/false (whether proof is sufficient),
  "confidence": 0-100 (confidence level in your assessment),
  "analysis": "Brief explanation of your decision (2-3 sentences)",
  "suggestions": "If not verified, what additional proof would help"
}

Be strict but fair. Look for:
1. Does the proof match what was requested?
2. Is there clear evidence of completion?
3. Could this be easily faked or misrepresented?
4. Does it show genuine effort and achievement?`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    verified: { type: "BOOLEAN" },
                    confidence: { type: "NUMBER", minimum: 0, maximum: 100 },
                    analysis: { type: "STRING" },
                    suggestions: { type: "STRING" }
                },
                required: ["verified", "confidence", "analysis"]
            },
            temperature: 0.3
        }
    };

    try {
        console.log('Sending milestone verification request to Gemini API...');
        
        const response = await axios.post(apiUrl, payload, {
            headers: { 
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
        
        const result = response.data;
        const contentPart = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!contentPart) {
            throw new Error("AI verification response was empty");
        }
        
        const verification = JSON.parse(contentPart);
        console.log('AI Verification Result:', verification);
        
        return verification;
        
    } catch (error) {
        console.error("AI Verification Error:", error.message);
        return {
            verified: false,
            confidence: 0,
            analysis: "AI verification service unavailable. Please use self-certification.",
            suggestions: "Try submitting again later or use self-certification option."
        };
    }
};

// POST /api/goals/create
router.post('/create', verifyToken, validateGoalCreation, async (req, res) => {
    const { title, depositAmount } = req.body;
    const userId = req.user.id;

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        if (user.walletBalance < depositAmount) {
            return res.status(400).json({ 
                message: `Insufficient balance. You have $${user.walletBalance.toFixed(2)} but need $${depositAmount.toFixed(2)}` 
            });
        }

        const enhancedPrompt = `You are an expert goal-setting coach. Analyze this specific goal: "${title}"

Create 4-6 SMART milestones that are:
- SPECIFIC to this exact goal (not generic)
- MEASURABLE with clear success criteria
- ACTIONABLE with concrete steps
- RELEVANT to achieving the stated goal
- TIME-BOUND when appropriate

IMPORTANT: For each milestone, also provide:
1. A clear description of what needs to be accomplished
2. Specific verification criteria that explain EXACTLY what evidence/proof would demonstrate completion
3. The type of proof needed (image, video, document, text, or any)

Examples:
- Fitness goal: "Complete 20 push-ups in one set" → Verification: "Video showing you performing 20 consecutive push-ups with proper form" → Proof type: video
- Learning goal: "Read Chapter 1-3 of [Book]" → Verification: "Written summary of key concepts from each chapter (minimum 200 words)" → Proof type: text
- Business goal: "Create logo and brand guidelines" → Verification: "PDF document showing final logo designs and brand color palette" → Proof type: document

Assign percentage weights based on difficulty and importance (must total 100%).

Respond with a JSON object containing a 'milestones' array where each milestone has:
{
  "description": "What to do",
  "verificationCriteria": "Exactly what proof/evidence is needed",
  "requiredProofType": "image|video|document|text|any",
  "percentage": number
}`;
        
        let milestones;
        try {
            console.log('Calling Gemini API for goal:', title);
            const aiResponse = await callGeminiAPI(enhancedPrompt);
            milestones = aiResponse.milestones;
            console.log('Generated milestones:', milestones);
            
            if (!milestones || milestones.length === 0) {
                throw new Error('Empty milestones response');
            }
            
            milestones = milestones.map(milestone => ({
                ...milestone,
                verificationCriteria: milestone.verificationCriteria || 'Provide evidence showing completion of this milestone',
                requiredProofType: milestone.requiredProofType || 'any'
            }));
            
        } catch (aiError) {
            console.error('AI generation failed:', aiError.message);
            
            const goalLower = title.toLowerCase();
            
            if (goalLower.includes('sleep') || goalLower.includes('wake') || goalLower.includes('get up') || goalLower.includes('morning')) {
                milestones = [
                    { 
                        description: `Establish consistent bedtime routine and set optimal sleep schedule for "${title}"`, 
                        percentage: 25,
                        verificationCriteria: 'Share your written sleep schedule and bedtime routine plan with specific times',
                        requiredProofType: 'text'
                    },
                    { 
                        description: `Successfully wake up at target time for 7 consecutive days without snoozing`, 
                        percentage: 30,
                        verificationCriteria: 'Provide 7 photos showing your alarm/phone display at wake-up time',
                        requiredProofType: 'image'
                    },
                    { 
                        description: `Maintain consistent wake-up time for 3 weeks and optimize sleep environment`, 
                        percentage: 25,
                        verificationCriteria: 'Submit sleep log showing 21 days of consistent wake times',
                        requiredProofType: 'text'
                    },
                    { 
                        description: `Achieve 30-day streak and establish sustainable habit`, 
                        percentage: 20,
                        verificationCriteria: 'Provide sleep tracking data showing 30-day consistency',
                        requiredProofType: 'any'
                    }
                ];
            } else if (goalLower.includes('weight') || goalLower.includes('kg') || goalLower.includes('fitness')) {
                milestones = [
                    { 
                        description: `Create detailed workout schedule and nutrition plan for "${title}"`, 
                        percentage: 20,
                        verificationCriteria: 'Share weekly workout plan and meal plan document',
                        requiredProofType: 'document'
                    },
                    { 
                        description: `Complete first month of consistent exercise and dietary changes`, 
                        percentage: 25,
                        verificationCriteria: 'Provide workout log showing 12+ workouts, plus progress photos',
                        requiredProofType: 'image'
                    },
                    { 
                        description: `Reach 50% progress milestone and adjust plan based on results`, 
                        percentage: 30,
                        verificationCriteria: 'Share progress photos, measurements, and updated plan',
                        requiredProofType: 'image'
                    },
                    { 
                        description: `Achieve final target and establish maintenance routine`, 
                        percentage: 25,
                        verificationCriteria: 'Provide final progress photos and weight measurements',
                        requiredProofType: 'image'
                    }
                ];
            } else {
                milestones = [
                    { 
                        description: `Define action plan and gather resources for "${title}"`, 
                        percentage: 20,
                        verificationCriteria: 'Share your detailed action plan',
                        requiredProofType: 'text'
                    },
                    { 
                        description: `Execute first phase with consistent actions`, 
                        percentage: 30,
                        verificationCriteria: 'Provide evidence of actions taken',
                        requiredProofType: 'any'
                    },
                    { 
                        description: `Evaluate progress and optimize approach`, 
                        percentage: 25,
                        verificationCriteria: 'Submit progress report with optimizations',
                        requiredProofType: 'text'
                    },
                    { 
                        description: `Complete final phase and achieve "${title}"`, 
                        percentage: 25,
                        verificationCriteria: 'Provide proof of completion',
                        requiredProofType: 'any'
                    }
                ];
            }
        }
        
        if (!milestones || milestones.length < 3 || milestones.length > 8) {
            throw new Error('Invalid number of milestones generated');
        }

        const newGoal = new Goal({
            userId,
            title: title.trim(),
            depositAmount,
            milestones,
            status: 'active'
        });
        await newGoal.save();

        user.walletBalance -= depositAmount;
        await user.save();

        console.log(`Goal created: ${title} for user ${userId}, $${depositAmount} deposited`);

        res.status(201).json({
            message: 'Goal created successfully!',
            goal: newGoal,
            remainingBalance: user.walletBalance
        });

    } catch (error) {
        console.error('Goal creation error:', error);
        res.status(500).json({ message: 'Error creating goal. Please try again.' });
    }
});

// PUT /api/goals/:goalId/milestones/:milestoneId/submit-proof
router.put('/:goalId/milestones/:milestoneId/submit-proof', verifyToken, async (req, res) => {
    const { goalId, milestoneId } = req.params;
    const { proofUrl, proofDescription, selfCertify, selfCertificationReason } = req.body;
    const userId = req.user.id;

    try {
        const goal = await Goal.findOne({ _id: goalId, userId: userId });
        if (!goal) {
            return res.status(404).json({ message: 'Goal not found or access denied' });
        }

        if (goal.status !== 'active') {
            return res.status(400).json({ message: 'Cannot complete milestones for inactive goals' });
        }

        const milestone = goal.milestones.id(milestoneId);
        if (!milestone) {
            return res.status(404).json({ message: 'Milestone not found' });
        }

        if (milestone.isCompleted) {
            return res.status(400).json({ message: 'This milestone is already completed' });
        }

        if (!selfCertify && !proofDescription) {
            return res.status(400).json({ 
                message: 'Please provide proof description or use self-certification' 
            });
        }

        if (selfCertify && !selfCertificationReason) {
            return res.status(400).json({ 
                message: 'Please provide a reason for self-certification' 
            });
        }

        milestone.proofUrl = proofUrl;
        milestone.proofDescription = proofDescription;
        milestone.selfCertified = selfCertify || false;
        milestone.selfCertificationReason = selfCertificationReason;

        let verificationResult;

        if (selfCertify) {
            milestone.verificationStatus = 'self_certified';
            milestone.aiVerification = {
                verified: false,
                confidence: 0,
                analysis: 'User self-certified completion without AI verification',
                verifiedAt: new Date()
            };
            verificationResult = {
                verified: true,
                confidence: 50,
                analysis: 'Self-certified by user',
                method: 'self_certification'
            };
        } else {
            try {
                verificationResult = await verifyMilestoneWithAI(
                    milestone, 
                    proofUrl, 
                    proofDescription
                );

                milestone.aiVerification = {
                    verified: verificationResult.verified,
                    confidence: verificationResult.confidence,
                    analysis: verificationResult.analysis,
                    verifiedAt: new Date()
                };

                if (verificationResult.verified && verificationResult.confidence >= 70) {
                    milestone.verificationStatus = 'ai_approved';
                } else if (verificationResult.confidence < 50) {
                    milestone.verificationStatus = 'manual_review';
                } else {
                    milestone.verificationStatus = 'pending';
                }

                verificationResult.method = 'ai_verification';

            } catch (aiError) {
                console.error('AI verification failed:', aiError);
                milestone.verificationStatus = 'pending';
                verificationResult = {
                    verified: false,
                    confidence: 0,
                    analysis: 'AI verification unavailable. Proof submitted for review.',
                    suggestions: 'You can self-certify or wait for manual review',
                    method: 'fallback'
                };
            }
        }

        if ((verificationResult.verified && verificationResult.confidence >= 70) || selfCertify) {
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            milestone.isCompleted = true;
            milestone.completedAt = new Date();
            milestone.verified = true;

            const refundAmount = Math.round((goal.depositAmount * (milestone.percentage / 100)) * 100) / 100;
            milestone.releasedAmount = refundAmount;

            user.walletBalance += refundAmount;

            const allCompleted = goal.milestones.every(m => m.isCompleted);
            if (allCompleted) {
                goal.status = 'completed';
                goal.completedAt = new Date();
            }

            await user.save();
            await goal.save();

            console.log(`Milestone completed with verification: ${milestone.description} - $${refundAmount} refunded`);

            res.json({ 
                message: 'Milestone verified and completed!', 
                refundAmount,
                verification: verificationResult,
                milestone: {
                    id: milestone._id,
                    description: milestone.description,
                    percentage: milestone.percentage,
                    isCompleted: true,
                    verified: true,
                    verificationStatus: milestone.verificationStatus,
                    releasedAmount: refundAmount
                },
                goalCompleted: allCompleted,
                newWalletBalance: user.walletBalance
            });

        } else {
            await goal.save();

            res.json({
                message: 'Proof submitted for review',
                verification: verificationResult,
                milestone: {
                    id: milestone._id,
                    description: milestone.description,
                    verificationStatus: milestone.verificationStatus,
                    aiVerification: milestone.aiVerification
                },
                nextSteps: verificationResult.suggestions || 'Your proof is under review. You can also choose to self-certify.'
            });
        }

    } catch (error) {
        console.error('Milestone proof submission error:', error);
        res.status(500).json({ message: 'Error submitting proof. Please try again.' });
    }
});

// GET /api/goals/user/:userId
router.get('/user/:userId', verifyToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        if (req.user.id !== userId) {
            return res.status(403).json({ message: 'Access denied' });
        }
        
        const goals = await Goal.find({ userId }).sort({ createdAt: -1 });
        
        res.json({
            goals,
            totalGoals: goals.length,
            activeGoals: goals.filter(g => g.status === 'active').length,
            completedGoals: goals.filter(g => g.status === 'completed').length
        });
    } catch (error) {
        console.error('Error fetching goals:', error);
        res.status(500).json({ message: 'Error fetching goals. Please try again.' });
    }
});

// GET /api/goals/wallet/balance
router.get('/wallet/balance', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('walletBalance name');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        const goals = await Goal.find({ userId: req.user.id });
        const totalDeposited = goals.reduce((sum, goal) => sum + goal.depositAmount, 0);
        const totalRefunded = goals.reduce((sum, goal) => {
            return sum + goal.milestones.reduce((milestoneSum, milestone) => {
                return milestoneSum + (milestone.releasedAmount || 0);
            }, 0);
        }, 0);

        res.json({ 
            walletBalance: user.walletBalance,
            userName: user.name,
            stats: {
                totalDeposited,
                totalRefunded,
                totalGoals: goals.length,
                activeGoals: goals.filter(g => g.status === 'active').length,
                completedGoals: goals.filter(g => g.status === 'completed').length
            }
        });
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        res.status(500).json({ message: 'Error fetching wallet information. Please try again.' });
    }
});

module.exports = router;