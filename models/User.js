const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters long'],
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please provide a valid email address'
    ]
  },
  passwordHash: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long']
  },
  walletBalance: {
    type: Number,
    default: 100, // Starting balance for new users
    min: [0, 'Wallet balance cannot be negative'],
    max: [1000000, 'Wallet balance cannot exceed $1,000,000']
  },
  profile: {
    avatar: {
      type: String,
      validate: {
        validator: function(v) {
          return !v || /^https?:\/\/.+/.test(v);
        },
        message: 'Avatar must be a valid HTTP/HTTPS URL'
      }
    },
    bio: {
      type: String,
      maxlength: [500, 'Bio cannot exceed 500 characters'],
      trim: true
    },
    timezone: {
      type: String,
      default: 'UTC'
    },
    preferences: {
      notifications: {
        email: { type: Boolean, default: true },
        push: { type: Boolean, default: true },
        milestoneReminders: { type: Boolean, default: true },
        goalDeadlines: { type: Boolean, default: true }
      },
      privacy: {
        profilePublic: { type: Boolean, default: false },
        shareProgress: { type: Boolean, default: false }
      }
    }
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'premium', 'enterprise'],
      default: 'free'
    },
    startDate: Date,
    endDate: Date,
    isActive: {
      type: Boolean,
      default: true
    }
  },
  stats: {
    goalsCreated: { type: Number, default: 0 },
    goalsCompleted: { type: Number, default: 0 },
    totalDeposited: { type: Number, default: 0 },
    totalRefunded: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 }, // Days of consistent milestone completion
    longestStreak: { type: Number, default: 0 },
    lastActivity: Date
  },
  security: {
    lastLogin: Date,
    loginAttempts: { type: Number, default: 0 },
    lockUntil: Date,
    twoFactorEnabled: { type: Boolean, default: false },
    backupCodes: [String]
  },
  verification: {
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    emailVerificationExpires: Date,
    passwordResetToken: String,
    passwordResetExpires: Date
  }
}, { 
  timestamps: true 
});

// Indexes for better performance
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ 'verification.emailVerificationToken': 1 });
UserSchema.index({ 'verification.passwordResetToken': 1 });

// Virtual for account lock status
UserSchema.virtual('isLocked').get(function() {
  return !!(this.security.lockUntil && this.security.lockUntil > Date.now());
});

// Pre-save middleware to hash password
UserSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('passwordHash')) return next();

  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Instance method to compare password
UserSchema.methods.comparePassword = async function(candidatePassword) {
  if (!candidatePassword || !this.passwordHash) return false;
  
  try {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  } catch (error) {
    return false;
  }
};

// Instance method to increment login attempts
UserSchema.methods.incLoginAttempts = function() {
  // If we have a previous lock that has expired, restart at 1
  if (this.security.lockUntil && this.security.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { 'security.lockUntil': 1 },
      $set: { 'security.loginAttempts': 1 }
    });
  }
  
  const updates = { $inc: { 'security.loginAttempts': 1 } };
  
  // Lock account after 5 failed attempts for 2 hours
  if (this.security.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = { 'security.lockUntil': Date.now() + (2 * 60 * 60 * 1000) }; // 2 hours
  }
  
  return this.updateOne(updates);
};

// Instance method to reset login attempts
UserSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { 
      'security.loginAttempts': 1,
      'security.lockUntil': 1
    },
    $set: { 'security.lastLogin': new Date() }
  });
};

// Instance method to update wallet balance safely
UserSchema.methods.updateWalletBalance = function(amount, operation = 'add') {
  const currentBalance = this.walletBalance || 0;
  
  if (operation === 'add') {
    this.walletBalance = currentBalance + amount;
  } else if (operation === 'subtract') {
    if (currentBalance < amount) {
      throw new Error('Insufficient wallet balance');
    }
    this.walletBalance = currentBalance - amount;
  } else {
    throw new Error('Invalid operation. Use "add" or "subtract"');
  }
  
  return this.save();
};

// Instance method to check if user can create goals
UserSchema.methods.canCreateGoal = function(depositAmount) {
  if (this.walletBalance < depositAmount) {
    return { canCreate: false, reason: 'Insufficient wallet balance' };
  }
  
  // Add subscription-based limits if needed
  if (this.subscription.plan === 'free' && this.stats.goalsCreated >= 5) {
    return { canCreate: false, reason: 'Free plan limit reached. Upgrade to create more goals.' };
  }
  
  return { canCreate: true };
};

// Static method to find users with low balances (for notifications)
UserSchema.statics.findLowBalanceUsers = function(threshold = 10) {
  return this.find({ walletBalance: { $lt: threshold } });
};

// Static method to get user statistics
UserSchema.statics.getUserStatistics = async function(userId) {
  const user = await this.findById(userId).select('stats walletBalance');
  if (!user) return null;
  
  // Get goal statistics from Goal model
  const Goal = mongoose.model('Goal');
  const goalStats = await Goal.getUserStats(userId);
  
  return {
    ...user.stats.toObject(),
    walletBalance: user.walletBalance,
    ...goalStats
  };
};

module.exports = mongoose.model('User', UserSchema);