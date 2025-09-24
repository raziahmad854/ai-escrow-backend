const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  description: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 500
  },
  percentage: { 
    type: Number, 
    required: true,
    min: 0,
    max: 100
  },
  isCompleted: { 
    type: Boolean, 
    default: false 
  },
  completedAt: {
    type: Date
  },
  // These fields are for future use and current tracking
  proofUrl: { 
    type: String,
    validate: {
      validator: function(v) {
        return !v || /^https?:\/\/.+/.test(v);
      },
      message: 'Proof URL must be a valid HTTP/HTTPS URL'
    }
  },
  verified: { 
    type: Boolean, 
    default: false 
  },
  releasedAmount: { 
    type: Number, 
    default: 0,
    min: 0
  },
  notes: {
    type: String,
    maxlength: 1000
  }
}, { 
  timestamps: true 
});

const goalSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  title: { 
    type: String, 
    required: true,
    trim: true,
    minlength: 5,
    maxlength: 500
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  depositAmount: { 
    type: Number, 
    required: true,
    min: 0.01,
    max: 100000
  },
  status: { 
    type: String, 
    enum: ['active', 'completed', 'failed', 'abandoned'], 
    default: 'active',
    index: true
  },
  deadline: { 
    type: Date,
    validate: {
      validator: function(v) {
        return !v || v > new Date();
      },
      message: 'Deadline must be in the future'
    }
  },
  completedAt: {
    type: Date
  },
  finalizedAt: {
    type: Date
  },
  milestones: [milestoneSchema],
  category: {
    type: String,
    enum: ['fitness', 'education', 'career', 'personal', 'financial', 'creative', 'other'],
    default: 'other'
  },
  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium'
  },
  estimatedDuration: {
    type: Number, // in days
    min: 1,
    max: 365
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  isPublic: {
    type: Boolean,
    default: false
  }
}, { 
  timestamps: true 
});

// Indexes for better query performance
goalSchema.index({ userId: 1, status: 1 });
goalSchema.index({ userId: 1, createdAt: -1 });
goalSchema.index({ status: 1, createdAt: -1 });

// Virtual for calculating total completion percentage
goalSchema.virtual('completionPercentage').get(function() {
  if (!this.milestones || this.milestones.length === 0) return 0;
  
  const completedMilestones = this.milestones.filter(m => m.isCompleted);
  return Math.round((completedMilestones.length / this.milestones.length) * 100);
});

// Virtual for calculating total refunded amount
goalSchema.virtual('totalRefunded').get(function() {
  if (!this.milestones) return 0;
  
  return this.milestones.reduce((total, milestone) => {
    return total + (milestone.releasedAmount || 0);
  }, 0);
});

// Virtual for calculating remaining deposit
goalSchema.virtual('remainingDeposit').get(function() {
  return this.depositAmount - this.totalRefunded;
});

// Pre-save middleware to validate milestone percentages
goalSchema.pre('save', function(next) {
  if (this.milestones && this.milestones.length > 0) {
    const totalPercentage = this.milestones.reduce((sum, milestone) => sum + milestone.percentage, 0);
    
    // Allow small rounding errors (within 1%)
    if (Math.abs(totalPercentage - 100) > 1) {
      const error = new Error('Milestone percentages must sum to approximately 100%');
      return next(error);
    }
  }
  next();
});

// Instance method to check if goal can be completed
goalSchema.methods.canBeCompleted = function() {
  return this.status === 'active' && 
         this.milestones.every(milestone => milestone.isCompleted);
};

// Instance method to complete the goal
goalSchema.methods.completeGoal = function() {
  if (this.canBeCompleted()) {
    this.status = 'completed';
    this.completedAt = new Date();
    return true;
  }
  return false;
};

// Static method to find active goals for a user
goalSchema.statics.findActiveByUser = function(userId) {
  return this.find({ userId, status: 'active' }).sort({ createdAt: -1 });
};

// Static method to get user goal statistics
goalSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalGoals: { $sum: 1 },
        activeGoals: {
          $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] }
        },
        completedGoals: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
        },
        failedGoals: {
          $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] }
        },
        totalDeposited: { $sum: "$depositAmount" },
        totalRefunded: {
          $sum: {
            $reduce: {
              input: "$milestones",
              initialValue: 0,
              in: { $add: ["$value", { $ifNull: ["$this.releasedAmount", 0] }] }
            }
          }
        }
      }
    }
  ]);

  return stats.length > 0 ? stats[0] : {
    totalGoals: 0,
    activeGoals: 0,
    completedGoals: 0,
    failedGoals: 0,
    totalDeposited: 0,
    totalRefunded: 0
  };
};

module.exports = mongoose.model('Goal', goalSchema);
