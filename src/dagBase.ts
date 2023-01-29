// this is modification of the solidity code
// the functions are not mirrors, as here the data is proceseed, so we can do more (this might change in the future, e.g. we might add depth)

import assert from "assert";

export type DagVote = {'id': string, 'weight': number, 'posInOther': number}
export type NodeDataStore = {"id":string, "name":string, "totalWeight":number; "onchainRep":number, "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[][][], "recDagVotes": DagVote[][][]}
export type GraphDataDict= { [id: string]: NodeDataStore}
export type GraphData = {"rootId": string, "maxRelRootDepth": number, "dict": GraphDataDict}

export const address0 = "0x0000000000000000000000000000000000000000";
export const address1 = "0x0000000000000000000000000000000000000001";

///////////////////
////// Update
export function joinTree( dag: GraphData ,  voter:string, name: string, recipient: string){
    // todo sanitity check
    if( dag.dict[voter] == undefined) {
        // error we need to reload the graph
    }

    dag.dict[voter].sentTreeVote = recipient;
    dag.dict[recipient].recTreeVotes.push(voter);

    dag.dict[voter].name = name;
    dag.dict[voter].id= voter;

    //this has its own event, so not needed.  
    //addDagVote(voter, recipient, 1);
}

export function changeName(dag: GraphData ,voter: string, newName: string){
    // todo a sanity check

    dag.dict[voter].name = newName;
}

export function addDagVote(dag: GraphData ,voter: string, recipient: string, weight: number){
    // todo sanity check 
    var [,dist, depth] = findDistDepth(dag, voter, recipient)
    combinedDagAppendSDist(dag, voter, recipient, dist, depth, weight);

}

export function removeDagVote(dag: GraphData ,voter: string, recipient: string){
    // sanity check that we have the voter recipient 
    var [,dist, depth] = findDistDepth(dag, voter, recipient)
    for (var count = 0; count<= dag.dict[voter].sentDagVotes[dist][depth].length; count++){
        if (dag.dict[voter].sentDagVotes[dist][depth][count].id == recipient){
            safeRemoveSentDagVoteDistDepthPos(dag, voter, dist, depth, count);
            return; 
        }
    }
    // we did not find voter, we need to reload the graph.
}

export function leaveTree(dag: GraphData ,voter:string) {
    // remove dag connections
    dag.dict[voter].sentDagVotes.forEach((sDagVoteAA, dist)=>{
        sDagVoteAA.forEach((sDagVoteA, depth)=>{
            sDagVoteA.forEach((sDagVote, count)=>{
                safeRemoveSentDagVoteDistDepthPos(dag, voter, dist, depth, count);
            })
        })
    });

    dag.dict[voter].recDagVotes.forEach((rDagVoteAA, dist)=>{
        rDagVoteAA.forEach((rDagVoteA, depth)=>{
            rDagVoteA.forEach((rDagVote, count)=>{
                safeRemoveRecDagVoteDistDepthPos(dag, voter, dist, depth, count);
            })
        })
    });

    handleLeavingVoterBranch(dag, voter);
    delete dag.dict[voter];
}

export function switchPositionWithParent(dag: GraphData ,voter:string){
    
    var parent = dag.dict[voter].sentTreeVote;
    assert (parent != address0);
    assert (parent != address1);
    var gparent = dag.dict[parent].sentTreeVote;
        
    handleDagVoteMove(dag,  parent, parent, voter, 0, 0);
    handleDagVoteMove( dag, voter, gparent, parent, 2, 2);
    
    switchTreeVoteWithParent(dag,  voter);
}

export function moveTreeVote(dag: GraphData ,voter: string, recipient: string){
    var dist, depth, bool
    if (dag.dict[voter].depth < dag.dict[recipient].depth){
        [bool, dist, depth] = findDistDepth(dag, voter, recipient)
    } else {
        var opDepth, opDist 
        [bool, opDist, opDepth]= findDistDepth(dag, recipient, voter)
        depth = -opDepth
        dist = opDist - opDepth
    }

    // we need to leave the tree nowm so that our descendants can rise. 
    var parent= dag.dict[voter].sentTreeVote;
    handleLeavingVoterBranch(dag,  voter);

    if ((dist == 0)){
        // if we are jumping to our descendant who just rose, we have to modify the lowerSDist
        if (findNthParent(dag,  recipient, depth)==parent){
            dist = dist - 1;
            depth = depth + 1;
        }
    }

    // we move to an empty  so replaced address is always 0. 
    handleDagVoteMove( dag,  voter, recipient, address0, dist, depth);
    
    // handle tree votes
    // there is a single twise here, if recipient the descendant of the voter that rises.
    addTreeVote(dag,   voter, recipient);
}

/////////////
////// treeVotes
function removeTreeVote(dag: GraphData ,voter: string){
    var parent = dag.dict[voter].sentTreeVote;
    dag.dict[voter].sentTreeVote=address1;
    dag.dict[parent].recTreeVotes.forEach((childId, index) => {
        if (childId == voter) {
            dag.dict[parent].recTreeVotes[index]=dag.dict[parent].recTreeVotes[dag.dict[parent].recTreeVotes.length-1];
            dag.dict[parent].recTreeVotes.pop();
            return;
        }
    })
    // there was an error, panic. 
}

function addTreeVote(dag: GraphData ,voter:string, recipient:string){
    dag.dict[voter].sentTreeVote = recipient;
    dag.dict[recipient].recTreeVotes.push(voter);
}

function switchTreeVoteWithParent(dag: GraphData , voter : string)  {
    var parent = dag.dict[voter].sentTreeVote;
    assert(parent != address0);
    assert(parent != address1);
    
    var gparent = dag.dict[parent].sentTreeVote; // this can be 1. 

    removeTreeVote(dag, voter);
    
    if (dag.rootId== parent){
        dag.rootId= voter;
    } else {
        removeTreeVote(dag, parent);
    }

    var brother = dag.dict[parent].recTreeVotes[0] ;

    var child1 = dag.dict[voter].recTreeVotes[0] ;
    var child2 = dag.dict[voter].recTreeVotes[0] ;
    
    addTreeVote(dag,  voter, gparent);
    addTreeVote(dag,  parent, voter);

    if (brother != address0) {
        removeTreeVote(dag, brother);
        addTreeVote(dag,  brother, voter);
    }

    if (child1 != address0) {
        removeTreeVote(dag, child1);
        addTreeVote(dag,  child1, parent);
    }

    if (child2 != address0) {
        removeTreeVote( dag, child2);
        addTreeVote( dag,  child2, parent);
    }
}


function pullUpBranch(dag: GraphData ,pulledVoter: string, parent: string){
    var firstChild = dag.dict[pulledVoter].recTreeVotes[0];
    var secondChild = dag.dict[pulledVoter].recTreeVotes[1];

    if (firstChild!=address0){
        handleDagVoteMove( dag,  firstChild, parent, pulledVoter, 2, 2);
    
        pullUpBranch( dag,  firstChild, pulledVoter);    

        if (secondChild != address0){
            removeTreeVote( dag,  secondChild);
            addTreeVote( dag,   secondChild, firstChild);
        }
    }
}

function handleLeavingVoterBranch(dag: GraphData ,voter: string){
    var parent = dag.dict[voter].sentTreeVote;

    var firstChild = dag.dict[voter].recTreeVotes[0];
    var secondChild = dag.dict[voter].recTreeVotes[1];

    if (firstChild!=address0){
        
        handleDagVoteMove( dag,  firstChild, parent, voter, 2, 2);

        pullUpBranch( dag,   firstChild, voter);

        if (secondChild != address0){
            removeTreeVote( dag,  secondChild);
            addTreeVote( dag,  secondChild, firstChild);
        }

        removeTreeVote( dag,   firstChild);
        addTreeVote( dag,  firstChild, parent);
    }

    removeTreeVote( dag,   voter);
    dag.dict[voter].sentTreeVote = address1;

    if (dag.rootId == voter ){
        dag.rootId = firstChild;
    }
}

///////////////////
////// DagVotes
function handleDagVoteMove(dag: GraphData ,voter: string, recipient: string, replaced: string, moveDist: number, heightToRec:number){
    collapseSquareIntoColumn(dag, voter, moveDist);
    moveSquareAlongDiagonal(dag, voter, heightToRec-1);
    sortSquareColumn(dag, voter, moveDist-heightToRec+1, recipient);
    if (replaced != address0) {
        sortSquareColumnDescendants(dag, voter, replaced);
    }
}

function collapseSquareIntoColumn(dag: GraphData ,voter: string, moveDist: number){
    // for each column move it to the destination column
    for (var dist = 0; dist< moveDist; dist++){
        for (var depth = 1; depth <= dist; depth++){
            moveSentDagCell(dag, voter, dist, depth, moveDist, depth);
        }

        for (var depth = 1; depth <= dag.maxRelRootDepth- dist; depth++){
            moveRecDagCell(dag, voter, dist, depth, moveDist, depth);
        }
    }
}

function moveSquareAlongDiagonal(dag: GraphData ,voter: string, diff: number){
    // rising, square down, start from bottom left. 
    if (diff > 0){ 
        for (var dist = 0; dist <= dag.maxRelRootDepth; dist ++){
            for (var height = 1; height <= dist; height++){
                moveSentDagCell(dag, voter, dist, height, dist-diff, height-diff);
            }

            for (var depth = dag.maxRelRootDepth - dist; 1 <= depth; depth--){
                moveRecDagCell(dag, voter, dist, depth, dist - diff, depth + diff);
            }
        }
    }

    // falling, square up, start from top right. 
    if (diff < 0) {
        for (var dist = dag.maxRelRootDepth; 0 <= dist ;dist --){
            for (var height = dist; 1<= height; height-- ){
                moveSentDagCell(dag, voter, dist, height, dist+diff, height+diff);
            }

            for (var depth=1; depth <= dag.maxRelRootDepth - dist; depth++){
                moveRecDagCell(dag, voter, dist, depth, dist + diff, depth - diff);
            }
        }
    }
}

function sortSquareColumn(dag: GraphData ,voter: string, moveDist: number, recipient: string){
        // Todo 
        // sort sentDagVotes
        // calculate ancestor of recipient at each depth to find new distance quickly
        var recipientAns = recipient; 
        for (var depth = 1; depth <= moveDist; depth++){
            for (var count = dag.dict[voter].sentDagVotes[moveDist][depth].length-1; 0<= count; count--){
                var sDagVote = dag.dict[voter].sentDagVotes[moveDist][depth][count];
                var [,distFromAns ] = findDistAtSameDepth(dag, sDagVote.id, recipientAns);
                if (distFromAns+depth != moveDist){
                    safeRemoveSentDagVoteDistDepthPos(dag, voter, moveDist, depth, count);
                    combinedDagAppendSDist(dag, voter, sDagVote.id, distFromAns+ depth, depth, sDagVote.weight);
                }
            }

        recipientAns = dag.dict[recipientAns].sentTreeVote;
    }
    
    // sort recDagVotes
    for (var depth = 1; depth <= dag.maxRelRootDepth - moveDist; depth++){
        for (var count = dag.dict[voter].recDagVotes[moveDist][depth].length-1; 0<= count; count--){

            var rDagVote = dag.dict[voter].recDagVotes[moveDist][depth][count];
            var [,sdist, ] = findDistDepth(dag, dag.dict[rDagVote.id].sentTreeVote, recipient);
            if (sdist+1-depth != moveDist){
                safeRemoveRecDagVoteDistDepthPos(dag, voter, moveDist, depth, count);
                combinedDagAppendSDist(dag, rDagVote.id, voter, sdist+1, depth, rDagVote.weight);
            }
        }
    }
}

function sortSquareColumnDescendants(dag: GraphData ,voter: string, replaced: string){
    for (var depth = 1; depth <= dag.maxRelRootDepth; depth++){
        for (var count =dag.dict[voter].recDagVotes[1][depth].length; 0<= count; count++){
            var rDagVote = dag.dict[voter].recDagVotes[1][depth][count];
            var anscestor = findNthParent(dag, rDagVote.id, depth);
            if (anscestor != replaced){
                safeRemoveRecDagVoteDistDepthPos(dag, voter, 1, depth, count);
                combinedDagAppendSDist(dag, rDagVote.id, voter, depth, depth, rDagVote.weight);
            }
        }
    }
}

// we could add this for efficiency, but we remove it for simplicity. The boundary checks in MoveCell make it redundant
    // function removeRecDagVoteBelowDepthInclusive(recipient: string, depth: number){
    //     for (var dist = 0; dist <= dag.maxRelRootDepth; dist++){
    //         for (var d = dag.maxRelRootDepth - dist; depth <= d; d--){
    //             for (var count = dag.dict[recipient].recDagVotes[dist][d].length-1; 0<= count; count--){
    //                 safeRemoveRecDagVoteDistDepthPos(recipient, dist, d, count);                    
    //             }
    //         }
    //     }   
    // }

function moveSentDagCell(dag: GraphData ,voter: string, sdist: number, height: number, newDist: number, newHeight: number){
    for (var count= dag.dict[voter].sentDagVotes[sdist][height].length-1; 0<= count; count--){
        var sDagVote = dag.dict[voter].sentDagVotes[sdist][height][count];
        
        safeRemoveSentDagVoteDistDepthPos(dag, voter, sdist, height, count);
        if ((newHeight<= newDist) && (newHeight>= 1) && (newDist<= dag.maxRelRootDepth)) {
            combinedDagAppendSDist(dag, voter, sDagVote.id, newDist, newHeight, sDagVote.weight);
        }
    }
}

function moveRecDagCell(dag: GraphData ,recipient: string, rdist: number, depth: number, newDist: number, newDepth: number){    
    for (var count= dag.dict[recipient].recDagVotes[rdist][depth].length-1; 0<= count; count--){
        var rDagVote = dag.dict[recipient].recDagVotes[rdist][depth][count];
        
        safeRemoveRecDagVoteDistDepthPos(dag, recipient, rdist, depth, count);
        if ((newDepth<= dag.maxRelRootDepth- newDist) && (newDepth>= 1) && (newDist>= 0)) {
            combinedDagAppendSDist(dag, rDagVote.id, recipient, newDist+newDepth, newDepth, rDagVote.weight);
        }
    }
}

///////////////////


function unsafeReplaceSentDagVoteAtDistDepthPosWithLast(dag: GraphData ,voter: string, sdist: number, depth: number, sPos: number){
    // find the vote we delete
    var sDagVote = dag.dict[voter].sentDagVotes[sdist][depth][sPos];      
    dag.dict[voter].totalWeight -= sDagVote.weight;

    if (sPos!= dag.dict[voter].sentDagVotes[sdist][depth].length-1) {
        // if we delete a vote in the middle, we need to copy the last vote to the deleted position
        var copiedSentDagVote = dag.dict[ voter].sentDagVotes[sdist][depth][ dag.dict[voter].sentDagVotes[sdist][depth].length-1];
        dag.dict[voter].sentDagVotes[sdist][depth][ sPos]= copiedSentDagVote;
        dag.dict[copiedSentDagVote.id].recDagVotes[sdist-depth][depth][copiedSentDagVote.posInOther].posInOther = sPos;
    }
    
    // delete the potentially copied hence duplicate last vote
    dag.dict[voter].sentDagVotes[sdist][depth].pop();
}

function unsafeReplaceRecDagVoteAtDistDepthPosWithLast(dag: GraphData ,recipient: string, rdist: number, depth: number, rPos: number){
    if (rPos!= dag.dict[recipient].recDagVotes[rdist][depth].length-1) {
        // if we delete a vote in the middle, we need to copy the last vote to the deleted position
        var copiedSentDagVote = dag.dict[recipient].recDagVotes[rdist][depth][dag.dict[recipient].recDagVotes[rdist][depth].length-1];
        dag.dict[recipient].recDagVotes[rdist][depth][ rPos]= copiedSentDagVote;
        dag.dict[copiedSentDagVote.id].sentDagVotes[rdist+depth][depth][copiedSentDagVote.posInOther].posInOther = rPos;
    }
    
    // delete the potentially copied hence duplicate last vote
    dag.dict[recipient].recDagVotes[rdist][depth].pop();
}

function safeRemoveSentDagVoteDistDepthPos(dag: GraphData ,voter: string, sdist: number, depth: number, sPos: number){
    var sDagVote = dag.dict[voter].sentDagVotes[sdist][depth][sPos];
    unsafeReplaceSentDagVoteAtDistDepthPosWithLast(dag, voter, sdist, depth, sPos);
    // delete the opposite
    unsafeReplaceRecDagVoteAtDistDepthPosWithLast(dag,  sDagVote.id, sdist-depth, depth, sDagVote.posInOther);
}

function safeRemoveRecDagVoteDistDepthPos(dag: GraphData ,recipient: string, rdist: number, depth: number, rPos: number){
    var rDagVote = dag.dict[recipient].recDagVotes[rdist][depth][rPos];
    unsafeReplaceRecDagVoteAtDistDepthPosWithLast(dag,  recipient, rdist, depth, rPos);
    // delete the opposite
    unsafeReplaceSentDagVoteAtDistDepthPosWithLast(dag,  rDagVote.id, rdist+depth, depth, rDagVote.posInOther);
}

function combinedDagAppendSDist(dag: GraphData ,voter: string, recipient: string, dist: number, depth: number, weight: number){
    var sLen = dag.dict[voter].sentDagVotes[dist][depth].length;
    var rLen = dag.dict[recipient].recDagVotes[dist][depth].length;
    dag.dict[voter].sentDagVotes[dist][depth].push({id: recipient, weight: weight, posInOther: rLen});
    dag.dict[voter].totalWeight += weight;
    dag.dict[recipient].recDagVotes[dist][depth].push({id: voter, weight: weight, posInOther: sLen});
}


/////////////

// rec has to be higher than voter.
function findDistDepth(dag: GraphData ,voter: string, recipient: string):[boolean, number, number]{
    var depthDiff = dag.dict[recipient].depth- dag.dict[voter].depth;
    var anscestor = findNthParent(dag, voter, depthDiff);
    var [sameDepth, dist] = findDistAtSameDepth(dag, anscestor, recipient);
    return [sameDepth, dist+depthDiff, depthDiff];
}

function findDistAtSameDepth(dag: GraphData ,add1: string, add2: string):[boolean, number ]{
    if (add1 == add2){
        return [true, 0];
    }
    
    if ( dag.dict[add1].sentTreeVote == address0 || dag.dict[add2].sentTreeVote == address0) {
        return [false, 0];
    }        

    if (dag.dict[add1].sentTreeVote == address1 || dag.dict[add2].sentTreeVote == address1) {
        return [false, 0];
    }

    var [isSameDepth, distance] = findDistAtSameDepth(dag,  dag.dict[add1].sentTreeVote, dag.dict[add2].sentTreeVote);

    if (isSameDepth == true) {
        return [true, distance + 1];
    }

    return [false, 0];
}

function findNthParent(dag: GraphData ,voter: string, height: number): string{
    if (height == 0) {
        return voter;
    }
    if (dag.dict[voter].sentTreeVote == address1) {
        return address1;
    }

    // this should never be the case, but it is a safety check
    assert (dag.dict[voter].sentTreeVote != address0);

    return findNthParent(dag,  dag.dict[voter].sentTreeVote, height-1);
}
