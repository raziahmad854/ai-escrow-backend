const express = require("express");
const router = express.Router();
const Goal = require("../models/Goal");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const axios = require("axios");

// Enhanced middleware to verify JWT token
const verifyToken = (req, res, next) => {
 const authHeader = req.header("Authorization");
 const token = authHeader?.split(" ")[1];

 if (!token) {
  return res.status(401).json({ message: "Access denied. No token provided." });
 }

 try {
  const verified = jwt.verify(token, process.env.JWT_SECRET);
  req.user = verified.user;
  next();
 } catch (err) {
  return res.status(401).json({ message: "Invalid or expired token." });
 }
};

// Input validation for goal creation
const validateGoalCreation = (req, res, next) => {
 const { title, depositAmount } = req.body;

 if (!title || title.trim().length < 5) {
  return res
   .status(400)
   .json({ message: "Goal title must be at least 5 characters long" });
 }

 if (!depositAmount || depositAmount < 1 || depositAmount > 10000) {
  return res
   .status(400)
   .json({ message: "Deposit amount must be between $1 and $10,000" });
 }

 next();
};

// Enhanced Gemini API function using axios
const callGeminiAPI = async (prompt) => {
 const apiKey = process.env.GEMINI_API_KEY;

 if (!apiKey) {
  throw new Error("Gemini API key is not configured");
 }

 const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

 const payload = {
  contents: [{ parts: [{ text: prompt }] }],
  generationConfig: {
   responseMimeType: "application/json",
   responseSchema: {
    type: "OBJECT",
    properties: {
     milestones: {
      type: "ARRAY",
      items: {
       type: "OBJECT",
       properties: {
        description: {
         type: "STRING",
         minLength: 20,
         maxLength: 200,
        },
        percentage: {
         type: "NUMBER",
         minimum: 5,
         maximum: 50,
        },
       },
       required: ["description", "percentage"],
      },
      minItems: 4,
      maxItems: 6,
     },
    },
    required: ["milestones"],
   },
   temperature: 0.8,
   topP: 0.9,
   topK: 40,
  },
 };

 try {
  console.log("Sending request to Gemini API...");

  const response = await axios.post(apiUrl, payload, {
   headers: {
    "Content-Type": "application/json",
    "User-Agent": "AI-Escrow-App/1.0",
   },
   timeout: 30000, // 30 second timeout
  });

  console.log("Gemini API Response Status:", response.status);
  const result = response.data;

  const contentPart = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!contentPart) {
   console.error("Empty response from Gemini API:", result);
   throw new Error("Gemini API response was empty or malformed");
  }

  const parsedContent = JSON.parse(contentPart);

  // Validate response structure
  if (!parsedContent.milestones || !Array.isArray(parsedContent.milestones)) {
   throw new Error("Invalid milestone structure in AI response");
  }

  // Validate that percentages sum to approximately 100
  const totalPercentage = parsedContent.milestones.reduce(
   (sum, milestone) => sum + milestone.percentage,
   0
  );
  console.log("Total percentage:", totalPercentage);

  if (Math.abs(totalPercentage - 100) > 5) {
   console.log("Normalizing percentages from", totalPercentage, "to 100");
   const factor = 100 / totalPercentage;
   parsedContent.milestones.forEach((milestone) => {
    milestone.percentage =
     Math.round(milestone.percentage * factor * 100) / 100;
   });
  }

  // Validate milestone quality
  parsedContent.milestones.forEach((milestone, index) => {
   if (!milestone.description || milestone.description.length < 20) {
    throw new Error(`Milestone ${index + 1} description is too short or empty`);
   }
   if (milestone.percentage < 5 || milestone.percentage > 50) {
    throw new Error(`Milestone ${index + 1} percentage is out of valid range`);
   }
  });

  console.log("Successfully validated AI-generated milestones");
  return parsedContent;
 } catch (error) {
  if (error.response) {
   // Axios error with response
   console.error(
    "Gemini API Response Error:",
    error.response.status,
    error.response.data
   );
   throw new Error(
    `Gemini API error (${error.response.status}): ${JSON.stringify(
     error.response.data
    )}`
   );
  } else if (error.request) {
   // Network error
   console.error("Gemini API Network Error:", error.message);
   throw new Error(`Network error calling Gemini API: ${error.message}`);
  } else {
   // Other error
   console.error("Gemini API Error Details:", error.message);
   throw error;
  }
 }
};

const validateAndFixMilestones = (milestones) => {
 return milestones.map((milestone) => {
  // Truncate description if it's too long
  let description = milestone.description;
  if (description.length > 500) {
   // Truncate at 497 characters and add "..."
   description = description.substring(0, 497) + "...";
   console.log(
    "Truncated milestone description from",
    milestone.description.length,
    "to",
    description.length,
    "characters"
   );
  }

  return {
   ...milestone,
   description: description.trim(),
  };
 });
};

// POST /api/goals/create
router.post("/create", verifyToken, validateGoalCreation, async (req, res) => {
 const { title, depositAmount } = req.body;
 const userId = req.user.id;

 try {
  // Check if user has sufficient balance
  const user = await User.findById(userId);
  if (!user) {
   return res.status(404).json({ message: "User not found" });
  }

  if (user.walletBalance < depositAmount) {
   return res.status(400).json({
    message: `Insufficient balance. You have $${user.walletBalance.toFixed(
     2
    )} but need $${depositAmount.toFixed(2)}`,
   });
  }

  // 1. Call Gemini to generate milestones with enhanced prompt
  const enhancedPrompt = `You are an expert goal-setting coach. Analyze this specific goal: "${title}"

Create 4-6 SMART milestones that are:
- SPECIFIC to this exact goal (not generic)
- MEASURABLE with clear success criteria
- ACTIONABLE with concrete steps
- RELEVANT to achieving the stated goal
- TIME-BOUND when appropriate

For the goal "${title}", break it down into logical, sequential steps. Each milestone should build toward the next one.

Examples:
- If it's a fitness goal, include specific workout plans, nutrition changes, measurements
- If it's a learning goal, include specific books/courses, practice hours, assessments
- If it's a business goal, include market research, product development, customer acquisition
- If it's a personal goal, include specific habits, timeframes, measurable outcomes

Assign percentage weights based on difficulty and importance (must total 100%).

Respond with a JSON object containing a 'milestones' array.`;

  let milestones;
  try {
   console.log("Calling Gemini API for goal:", title);
   const aiResponse = await callGeminiAPI(enhancedPrompt);
   milestones = aiResponse.milestones;
   console.log("Generated milestones:", milestones);

   // Validate AI response quality
   if (!milestones || milestones.length === 0) {
    throw new Error("Empty milestones response");
   }

   // Check if milestones are too generic (contain common generic words)
   const genericWords = [
    "plan",
    "prepare",
    "first quarter",
    "halfway",
    "final phase",
   ];
   const isGeneric = milestones.every((milestone) =>
    genericWords.some((word) =>
     milestone.description.toLowerCase().includes(word)
    )
   );

   if (isGeneric) {
    throw new Error("Generated milestones are too generic");
   }
  } catch (aiError) {
   console.error("AI generation failed:", aiError.message);

   // Create more specific fallback based on goal content
   const goalLower = title.toLowerCase();

   if (
    goalLower.includes("sleep") ||
    goalLower.includes("wake") ||
    goalLower.includes("get up") ||
    goalLower.includes("morning") ||
    goalLower.includes("bedtime")
   ) {
    milestones = [
     {
      description: `Establish a consistent bedtime routine and set optimal sleep schedule for "${title}"`,
      percentage: 25,
     },
     {
      description: `Successfully wake up at target time for 7 consecutive days without snoozing`,
      percentage: 30,
     },
     {
      description: `Maintain consistent wake-up time for 3 weeks and optimize sleep environment`,
      percentage: 25,
     },
     {
      description: `Achieve 30-day streak of waking up on time and establish sustainable habit`,
      percentage: 20,
     },
    ];
   } else if (
    goalLower.includes("weight") ||
    goalLower.includes("kg") ||
    goalLower.includes("lose") ||
    goalLower.includes("fitness") ||
    goalLower.includes("exercise")
   ) {
    milestones = [
     {
      description: `Create a detailed workout schedule and nutrition plan for "${title}"`,
      percentage: 20,
     },
     {
      description: `Complete first month of consistent exercise and dietary changes`,
      percentage: 25,
     },
     {
      description: `Reach 50% progress milestone and adjust plan based on results`,
      percentage: 30,
     },
     {
      description: `Achieve final target and establish maintenance routine`,
      percentage: 25,
     },
    ];
   } else if (
    goalLower.includes("read") ||
    goalLower.includes("book") ||
    goalLower.includes("learn") ||
    goalLower.includes("study")
   ) {
    milestones = [
     {
      description: `Select and acquire all materials needed for "${title}"`,
      percentage: 15,
     },
     {
      description: `Complete first 30% of the learning/reading goal`,
      percentage: 25,
     },
     {
      description: `Reach halfway point and review/test comprehension`,
      percentage: 30,
     },
     {
      description: `Complete remaining material and demonstrate mastery`,
      percentage: 30,
     },
    ];
   } else if (
    goalLower.includes("business") ||
    goalLower.includes("career") ||
    goalLower.includes("job") ||
    goalLower.includes("money")
   ) {
    milestones = [
     {
      description: `Research and plan the strategy for "${title}"`,
      percentage: 20,
     },
     {
      description: `Execute initial phase and gather feedback`,
      percentage: 30,
     },
     { description: `Refine approach and scale up efforts`, percentage: 25 },
     {
      description: `Achieve the target and establish sustainable processes`,
      percentage: 25,
     },
    ];
   } else {
    // More thoughtful generic fallback
    milestones = [
     {
      description: `Define specific action plan and gather resources for "${title}"`,
      percentage: 20,
     },
     {
      description: `Execute first phase with consistent daily/weekly actions`,
      percentage: 30,
     },
     {
      description: `Evaluate progress, overcome obstacles, and optimize approach`,
      percentage: 25,
     },
     {
      description: `Complete final phase and achieve "${title}" successfully`,
      percentage: 25,
     },
    ];
   }
  }

  // Validate and fix milestone descriptions before saving
  milestones = validateAndFixMilestones(milestones);

  // Validate milestones
  if (!milestones || milestones.length < 3 || milestones.length > 8) {
   throw new Error("Invalid number of milestones generated");
  }
  // 2. Create a new Goal document
  const newGoal = new Goal({
   userId,
   title: title.trim(),
   depositAmount,
   milestones,
   status: "active",
  });
  await newGoal.save();

  // 3. Update the user's wallet (deduct the deposit)
  user.walletBalance -= depositAmount;
  await user.save();

  console.log(
   `Goal created: ${title} for user ${userId}, $${depositAmount} deposited`
  );

  res.status(201).json({
   message: "Goal created successfully!",
   goal: newGoal,
   remainingBalance: user.walletBalance,
  });
 } catch (error) {
  console.error("Goal creation error:", error);
  if (error.message.includes("Gemini API")) {
   res.status(503).json({
    message: "AI service temporarily unavailable. Please try again later.",
   });
  } else {
   res.status(500).json({ message: "Error creating goal. Please try again." });
  }
 }
});

// PUT /api/goals/:goalId/milestones/:milestoneId/complete
router.put(
 "/:goalId/milestones/:milestoneId/complete",
 verifyToken,
 async (req, res) => {
  const { goalId, milestoneId } = req.params;
  const userId = req.user.id;

  try {
   // Find the goal and validate ownership
   const goal = await Goal.findOne({ _id: goalId, userId: userId });
   if (!goal) {
    return res.status(404).json({ message: "Goal not found or access denied" });
   }

   if (goal.status !== "active") {
    return res
     .status(400)
     .json({ message: "Cannot complete milestones for inactive goals" });
   }

   // Find the specific milestone
   const milestone = goal.milestones.id(milestoneId);
   if (!milestone) {
    return res.status(404).json({ message: "Milestone not found" });
   }

   if (milestone.isCompleted) {
    return res
     .status(400)
     .json({ message: "This milestone is already completed" });
   }

   // Find the user for wallet update
   const user = await User.findById(userId);
   if (!user) {
    return res.status(404).json({ message: "User not found" });
   }

   // Mark milestone as complete
   milestone.isCompleted = true;
   milestone.completedAt = new Date();

   // Calculate refund amount
   const refundAmount =
    Math.round(goal.depositAmount * (milestone.percentage / 100) * 100) / 100;
   milestone.releasedAmount = refundAmount;

   // Update user's wallet balance
   user.walletBalance += refundAmount;

   // Check if all milestones are completed
   const allCompleted = goal.milestones.every((m) => m.isCompleted);
   if (allCompleted) {
    goal.status = "completed";
    goal.completedAt = new Date();
   }

   // Save both documents
   await user.save();
   await goal.save();

   console.log(
    `Milestone completed: ${milestone.description} - $${refundAmount} refunded to user ${userId}`
   );

   res.json({
    message: "Milestone marked as complete!",
    refundAmount,
    milestone: {
     id: milestone._id,
     description: milestone.description,
     percentage: milestone.percentage,
     isCompleted: true,
     releasedAmount: refundAmount,
    },
    goalCompleted: allCompleted,
    newWalletBalance: user.walletBalance,
   });
  } catch (error) {
   console.error("Milestone completion error:", error);
   res
    .status(500)
    .json({ message: "Error completing milestone. Please try again." });
  }
 }
);

// GET /api/goals/user/:userId
router.get("/user/:userId", verifyToken, async (req, res) => {
 try {
  const userId = req.params.userId;

  // Security check: ensure the token's user ID matches the requested user ID
  if (req.user.id !== userId) {
   return res.status(403).json({ message: "Access denied" });
  }

  const goals = await Goal.find({ userId }).sort({ createdAt: -1 });

  res.json({
   goals,
   totalGoals: goals.length,
   activeGoals: goals.filter((g) => g.status === "active").length,
   completedGoals: goals.filter((g) => g.status === "completed").length,
  });
 } catch (error) {
  console.error("Error fetching goals:", error);
  res.status(500).json({ message: "Error fetching goals. Please try again." });
 }
});

// GET /api/goals/wallet/balance
router.get("/wallet/balance", verifyToken, async (req, res) => {
 try {
  const user = await User.findById(req.user.id).select("walletBalance name");
  if (!user) {
   return res.status(404).json({ message: "User not found" });
  }

  // Also get goal statistics for the wallet page
  const goals = await Goal.find({ userId: req.user.id });
  const totalDeposited = goals.reduce(
   (sum, goal) => sum + goal.depositAmount,
   0
  );
  const totalRefunded = goals.reduce((sum, goal) => {
   return (
    sum +
    goal.milestones.reduce((milestoneSum, milestone) => {
     return milestoneSum + (milestone.releasedAmount || 0);
    }, 0)
   );
  }, 0);

  res.json({
   walletBalance: user.walletBalance,
   userName: user.name,
   stats: {
    totalDeposited,
    totalRefunded,
    totalGoals: goals.length,
    activeGoals: goals.filter((g) => g.status === "active").length,
    completedGoals: goals.filter((g) => g.status === "completed").length,
   },
  });
 } catch (error) {
  console.error("Error fetching wallet balance:", error);
  res
   .status(500)
   .json({ message: "Error fetching wallet information. Please try again." });
 }
});

module.exports = router;
