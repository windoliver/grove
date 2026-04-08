import type { ContributionStore, ClaimStore } from '../store.js';
import type { ContentStore } from '../cas.js';
import type { ContributionInput, Contribution, ClaimInput } from '../models.js';
import { createContribution } from '../models.js';
import { createClaim } from '../models.js';
import { generateId } from '../id.js';

export interface ContributeOperationDeps {
  contributionStore: ContributionStore;
  claimStore: ClaimStore;
  contentStore: ContentStore;
}

export async function contributeOperation(
  deps: ContributeOperationDeps,
  input: ContributionInput,
  handoffConfig?: {
    agentId: string;
    sessionId: string;
    instructions?: string;
  }
): Promise<Contribution> {
  const contribution = await createContribution(deps.contentStore, input);
  
  // Check if store supports atomic co-writes
  const store = deps.contributionStore as any;
  const supportsCowrite = typeof store.putWithCowrite === 'function';
  
  if (supportsCowrite && handoffConfig) {
    // Atomic path: both writes in same transaction
    const handoffClaim: ClaimInput = {
      agentId: handoffConfig.agentId,
      sessionId: handoffConfig.sessionId,
      type: 'task',
      priority: 'normal',
      instructions: handoffConfig.instructions || `Work on contribution ${contribution.id}`,
      metadata: {
        contributionId: contribution.id,
        handoff: true
      }
    };
    
    const claim = createClaim(handoffClaim);
    
    await store.putWithCowrite(
      contribution,
      deps.claimStore,
      claim
    );
  } else {
    // Non-atomic path: write contribution first, then handoff with rollback on failure
    await deps.contributionStore.put(contribution);
    
    if (handoffConfig) {
      try {
        const handoffClaim: ClaimInput = {
          agentId: handoffConfig.agentId,
          sessionId: handoffConfig.sessionId,
          type: 'task',
          priority: 'normal',
          instructions: handoffConfig.instructions || `Work on contribution ${contribution.id}`,
          metadata: {
            contributionId: contribution.id,
            handoff: true
          }
        };
        
        const claim = createClaim(handoffClaim);
        await deps.claimStore.put(claim);
      } catch (error) {
        // Rollback: delete the contribution if handoff creation fails
        try {
          await deps.contributionStore.delete(contribution.id);
        } catch (rollbackError) {
          // Log rollback failure but don't mask original error
          console.error('Failed to rollback contribution after handoff failure:', rollbackError);
        }
        throw error;
      }
    }
  }
  
  return contribution;
}