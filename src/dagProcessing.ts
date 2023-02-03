import {GraphData, address0, NodeDataStore, DagVote} from "./dagBase";


//////////////
///// Process 


export function calculateDepthAndRelRoot(dag: GraphData, depthA: string[][] ){
    var parentsArray = Array.apply(null, Array(5)).map(()=> {return dag.rootId})
    calculateDepthAndRelRootInner(dag,depthA,  dag.rootId, 0, parentsArray);

}

function calculateDepthAndRelRootInner(dag: GraphData, depthA: string[][],  id:string, depth: number, parents: string[]){
    dag.dict[id].depth = depth;
    dag.dict[id].relRoot = parents[0];

    if (depthA[depth] == undefined){
        depthA[depth] = [];
    }
    depthA[depth].push(id);
 
    dag.dict[id].recTreeVotes.forEach((childId) => {
        var newParents = parents.slice(1);
        newParents.push(id);
        calculateDepthAndRelRootInner(dag, depthA, childId, depth+1, newParents);
    });

}

export function calculateReputation(dag: GraphData, depthA: string[][]){
  
    for (var i = depthA.length-1; i >= 0; i--) {
        depthA[i].forEach((id) => {
            var node = dag.dict[id];
            node.currentRep = 10**18;

            node.recDagVotes.forEach((rDagVoteAA) => {
                rDagVoteAA.forEach((rDagVoteA) => {
                    rDagVoteA.forEach((rDagVote) => {
                        var voter = dag.dict[rDagVote.id]
                        node.currentRep += rDagVote.weight* voter.currentRep/voter.totalWeight;
                    })
                })
            })
        });
    }
}

export function findRandomLeaf(dag: GraphData):string{
    var nodeId = dag.rootId;

    // console.log("finding random leaf", nodeId, dag.dict[nodeId], dag.dict[nodeId].recTreeVotes)
    while (dag.dict[nodeId].recTreeVotes.length == 2){
        var rand = Math.floor(Math.random() * 2);
        nodeId = dag.dict[nodeId].recTreeVotes[rand];
    }
    return nodeId;
}

////////////////////////////