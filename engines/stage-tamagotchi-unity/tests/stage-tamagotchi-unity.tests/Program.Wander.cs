using System;
using System.Collections.Generic;
using Airi.Stage.Core;

/// <summary>Tests of the plan that moves the character through a room.</summary>
public static partial class Program
{
    /// <summary>A room that gives its destinations in order, and none when the list ends. A path reaches each point.</summary>
    private sealed class ListRoom : IWanderRoom
    {
        private readonly Queue<StagePoint> _points;

        public ListRoom(params StagePoint[] points)
        {
            _points = new Queue<StagePoint>(points);
        }

        public int Asked { get; private set; }

        public bool CanSit { get; set; } = true;

        /// <summary>The X of points that no path reaches.</summary>
        public HashSet<double> Unreachable { get; } = new HashSet<double>();

        public bool CanReach(StagePoint point)
        {
            return !Unreachable.Contains(point.X);
        }

        public bool TryPickDestination(Func<double> random, out StagePoint destination)
        {
            Asked++;
            if (_points.Count == 0)
            {
                destination = default;
                return false;
            }

            destination = _points.Dequeue();
            return true;
        }
    }

    private static void TestWander()
    {
        TestWanderRestAndWalk();
        TestWanderAttention();
        TestWanderNoDestination();
    }

    /// <summary>Runs the plan in steps of 0.5 seconds, and returns the first change, or None after the time.</summary>
    private static WanderChange RunUntilChange(WanderPlan plan, double seconds, bool arrived, bool attention)
    {
        for (double time = 0; time < seconds; time += 0.5)
        {
            WanderChange change = plan.Update(0.5, arrived, attention);
            if (change != WanderChange.None)
            {
                return change;
            }
        }

        return WanderChange.None;
    }

    private static void TestWanderRestAndWalk()
    {
        // A random value of 0.5 gives a rest of 13 seconds.
        var room = new ListRoom(new StagePoint(1, 0, 2), new StagePoint(3, 0, 4));
        var plan = new WanderPlan(room, () => 0.5);
        Check(plan.State == WanderState.Rest, "the character rests at the start");
        Check(RunUntilChange(plan, 12.5, false, false) == WanderChange.None, "the rest lasts its time");
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk, "a walk starts after the rest");
        Check(plan.State == WanderState.Walk && plan.Destination.X == 1 && plan.Destination.Z == 2, "the walk goes to the first destination");

        Check(RunUntilChange(plan, 5, false, false) == WanderChange.None, "the walk lasts until the arrival");
        Check(plan.Update(0.5, true, false) == WanderChange.EndWalk, "the arrival ends the walk");
        Check(plan.State == WanderState.Rest, "the character rests after a walk");

        Check(RunUntilChange(plan, 14, false, false) == WanderChange.StartWalk, "the next walk starts after the next rest");
        Check(plan.Destination.X == 3, "the next walk goes to the next destination");
        Check(RunUntilChange(plan, WanderPlan.WalkLimitSeconds + 1, false, false) == WanderChange.EndWalk, "a walk without arrival ends at its limit");

        // The rest takes the random value: 0 gives the shortest rest, and 1 the longest.
        var quick = new WanderPlan(new ListRoom(new StagePoint(0, 0, 0)), () => 0);
        Check(RunUntilChange(quick, WanderPlan.MinRestSeconds + 0.5, false, false) == WanderChange.StartWalk, "a random value of 0 gives the shortest rest");
        var slow = new WanderPlan(new ListRoom(new StagePoint(0, 0, 0)), () => 1);
        Check(RunUntilChange(slow, WanderPlan.MaxRestSeconds - 0.5, false, false) == WanderChange.None, "a random value of 1 gives the longest rest");
    }

    private static void TestWanderAttention()
    {
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1), new StagePoint(2, 0, 2)), () => 0);
        Check(plan.Update(0.5, false, true) == WanderChange.StartAttend, "attention stops a rest");
        Check(RunUntilChange(plan, 60, false, true) == WanderChange.None, "the character attends as long as the host asks");
        Check(plan.Update(0.5, false, false) == WanderChange.EndAttend, "a release ends the attention");
        Check(plan.State == WanderState.Rest, "the character rests after the attention");

        Check(RunUntilChange(plan, 7, false, false) == WanderChange.StartWalk, "a walk starts after the rest");
        Check(plan.Update(0.5, false, true) == WanderChange.StartAttend, "attention stops a walk");
        Check(plan.State == WanderState.Attend, "the plan attends");
    }

    private static void TestWanderNoDestination()
    {
        var room = new ListRoom();
        var plan = new WanderPlan(room, () => 0);
        Check(RunUntilChange(plan, 30, false, false) == WanderChange.None, "a room without a destination keeps the character at rest");
        Check(plan.State == WanderState.Rest, "the character rests in a room without a destination");
        Check(room.Asked >= 4, $"the plan asks again after each rest: {room.Asked}");
    }
}
