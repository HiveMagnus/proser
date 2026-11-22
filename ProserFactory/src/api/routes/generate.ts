import { Router } from 'express';
import { GenerateController } from '../controllers/generate';
import { authenticateRequest } from '../middleware/auth';
import { zBody } from '../middleware/zodValidation';
import { codexGenBody, outlineBody, summaryBody, titleBody, taglineBody, inlineSuggestionBody, feedbackBody, structureGenBody, proseBody, proseOperationBody, batchProseBody, reviseFromFindingsBody, commandReviseBody } from '../schemas/generate';
import { idempotent } from '../middleware/idempotency';
import { generationRateLimit } from '../contracts/routeLimits';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateRequest);
router.post('/operations',
  generationRateLimit('operationCreate'),
  zBody(proseOperationBody),
  GenerateController.createOperation,
);

router.get('/operations/unresolved',
  generationRateLimit('operationUnresolved'),
  GenerateController.unresolvedOperations,
);

router.get('/operations/lookup',
  generationRateLimit('operationLookup'),
  GenerateController.lookupOperation,
);

router.get('/operations/:operationId/stream',
  generationRateLimit('operationStream'),
  GenerateController.resumeStream,
);

router.get('/operations/:operationId',
  generationRateLimit('operationRead'),
  GenerateController.getOperation,
);

router.get('/operations/:operationId/artifact',
  generationRateLimit('operationArtifact'),
  GenerateController.getOperationArtifact,
);

router.post('/operations/:operationId/cancel',
  generationRateLimit('operationCancel'),
  GenerateController.cancelOperation,
);

// Character generation
router.post('/character',
  generationRateLimit('character'),
  zBody(codexGenBody),
  GenerateController.generateCharacter
);

// Location generation
router.post('/location',
  generationRateLimit('location'),
  zBody(codexGenBody),
  GenerateController.generateLocation
);

// Item generation
router.post('/item',
  generationRateLimit('item'),
  zBody(codexGenBody),
  GenerateController.generateItem
);

// Generic codex entry generation (faction, event, rule, culture, relationship, etc.)
router.post('/codex',
  generationRateLimit('codex'),
  zBody(codexGenBody),
  GenerateController.generateCodexEntry
);

// Story outline generation
router.post('/outline',
  generationRateLimit('outline'),
  zBody(outlineBody),
  GenerateController.generateOutline
);

// Summary generation
router.post('/summary',
  generationRateLimit('summary'),
  zBody(summaryBody),
  GenerateController.generateSummary
);

// Title generation
router.post('/title',
  generationRateLimit('title'),
  zBody(titleBody),
  GenerateController.generateTitle
);

// Tagline generation
router.post('/tagline',
  generationRateLimit('tagline'),
  zBody(taglineBody),
  GenerateController.generateTagline
);

// Inline suggestion generation
router.post('/inline-suggestion',
  generationRateLimit('inlineSuggestion'),
  zBody(inlineSuggestionBody),
  GenerateController.generateInlineSuggestion
);

// Feedback generation
router.post('/feedback',
  generationRateLimit('feedback'),
  zBody(feedbackBody),
  GenerateController.generateFeedback
);

// Structure generation
router.post('/structure',
  generationRateLimit('structure'),
  zBody(structureGenBody),
  GenerateController.generateStructure
);

export default router;

// Prose generation with optional Codex RAG
router.post('/prose/batch',
  generationRateLimit('proseBatch'),
  zBody(batchProseBody),
  GenerateController.batchGenerateProse
);

router.post('/prose',
  generationRateLimit('prose'),
  idempotent(),
  zBody(proseBody),
  GenerateController.generateProse
);

// Closed-loop revision: revise prose based on skill findings
router.post('/prose/revise',
  generationRateLimit('proseRevise'),
  idempotent(),
  zBody(reviseFromFindingsBody),
  GenerateController.reviseFromFindings
);

router.post('/prose/command-revise',
  generationRateLimit('commandRevise'),
  idempotent(),
  zBody(commandReviseBody),
  GenerateController.commandRevise
);
