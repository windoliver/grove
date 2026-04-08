import type { ClaimStore, BountyStore } from '../store.js';
import type { ClaimInput, Claim } from '../models.js';
import { createClaim } from '../models.js';

export interface ClaimBountyOperationDeps {
  claimStore: ClaimStore;
  bountyStore: BountyStore;
}

export async function claimBountyOperation(
  deps: ClaimBountyOperationDeps,
  bountyId: string,
  claimInput: ClaimInput
): Promise<Claim> {
  const claim = createClaim(claimInput);
  
  // Check if stores support atomic operations
  const claimStore = deps.claimStore as any;
  const bountyStore = deps.bountyStore as any;
  
  // If both stores are SQLite-based and support transactions, use atomic operation
  if (typeof claimStore.transaction === 'function' && 
      typeof bountyStore.transaction === 'function' &&
      claimStore.transaction === bountyStore.transaction) {
    // Both stores share the same transaction mechanism (likely SQLite)
    await claimStore.transaction(async () => {
      await deps.claimStore.put(claim);
      await deps.bountyStore.claimBounty(bountyId, claim.id);
    });
  } else {
    // Non-atomic path with compensating action
    await deps.claimStore.put(claim);
    
    try {
      await deps.bountyStore.claimBounty(bountyId, claim.id);
    } catch (error) {
      // Compensating action: remove the claim if bounty update fails
      try {
        await deps.claimStore.delete(claim.id);
      } catch (rollbackError) {
        // Log rollback failure but don't mask original error
        console.error('Failed to rollback claim after bounty update failure:', rollbackError);
      }
      throw error;
    }
  }
  
  return claim;
}