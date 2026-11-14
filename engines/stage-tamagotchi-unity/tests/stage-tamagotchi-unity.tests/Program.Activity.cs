using Airi.Stage.Core;

/// <summary>Tests of the activity of watching a screen, for a commentary.</summary>
public static partial class Program
{
    private static void TestActivity()
    {
        TestActivityAtTheDesk();
        TestActivityFromElsewhere();
        TestActivityAtAStandingScreen();
        TestActivityWithoutScreen();
    }

    /// <summary>A chair at x = 5, a desk with a screen and a seat at x = 3, and a TV at x = 8.</summary>
    private static StageRoomPlace[] RoomWithDesk()
    {
        var monitor = new StageRoomScreen("Monitor", "Screen", new StagePoint(2, 1, 0), 90, 0.9, 0.5);
        var tv = new StageRoomScreen("TV", "Black", new StagePoint(9, 1, 0), 270, 1.5, 0.8);
        return new[]
        {
            new StageRoomPlace("Chair", StageRoomPlaceRole.Seat, new StagePoint(5, 0, 0), 90, new StagePoint(5.5, 0.45, 0), null),
            new StageRoomPlace("Desk", StageRoomPlaceRole.Screen, new StagePoint(3, 0, 0), 270, new StagePoint(2.6, 0.5, 0), monitor),
            new StageRoomPlace("TV", StageRoomPlaceRole.Screen, new StagePoint(8, 0, 0), 90, null, tv),
        };
    }

    private static void TestActivityAtTheDesk()
    {
        // A random value of 0.9 sends no rest to a place, so only the activity does.
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, RoomWithDesk());
        Check(plan.ScreenPlace?.Name == "Desk", "the first screen place takes the activity");
        Check(!plan.WatchingScreen && !plan.LooksAtScreen, "no activity at the start");

        Check(plan.SetWatchingScreen(true), "a room with a screen place takes the activity");
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk, "the activity ends the rest at once");
        Check(plan.Place?.Name == "Desk" && plan.Destination.X == 3, "she walks to the stand point of the screen place");
        Check(RunUntilChange(plan, 10, false, true) == WanderChange.None, "the viewer does not stop her walk to the screen");
        Check(plan.State == WanderState.Walk, "she still walks during the attention");

        Check(plan.Update(0.5, true, false) == WanderChange.StartApproach, "at the screen place, she steps to its seat");
        Check(plan.Update(0.5, true, false) == WanderChange.SitDown, "she sits down at the screen");
        Check(plan.LooksAtScreen, "she watches the screen while she sits");
        Check(RunUntilChange(plan, WanderPlan.MaxSitSeconds * 2, false, false) == WanderChange.None, "she sits as long as the activity goes on");
        Check(RunUntilChange(plan, 10, false, true) == WanderChange.None, "the viewer does not get her up");

        Check(plan.SetWatchingScreen(false), "the activity can end");
        Check(!plan.LooksAtScreen, "she stops to watch the screen when the activity ends");
        Check(plan.Update(0.5, false, false) == WanderChange.StandUp, "the end of the activity gets her up");
        Check(plan.State == WanderState.Leave, "she goes back to the stand point");
        Check(plan.Update(0.5, true, false) == WanderChange.EndSit, "the stand point ends the sit");
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk, "her walk through the room goes on");
    }

    private static void TestActivityFromElsewhere()
    {
        // She sits on the chair after an asked visit.
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1), new StagePoint(6, 0, 6)), () => 0.9, RoomWithDesk());
        plan.AskPlace("Chair");
        RunUntilChange(plan, WanderPlan.MaxRestSeconds, false, false);
        plan.Update(0.5, true, false);
        plan.Update(0.5, true, false);
        Check(plan.State == WanderState.Sit && plan.Place?.Name == "Chair", "she sits on the chair");

        plan.SetWatchingScreen(true);
        Check(plan.Update(0.5, false, false) == WanderChange.StandUp, "the activity gets her up from another seat");
        Check(!plan.LooksAtScreen, "she does not watch the screen from another seat");
        Check(plan.Update(0.5, true, false) == WanderChange.EndSit, "she goes back to the stand point of the chair");
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk && plan.Place?.Name == "Desk", "then she walks to the screen place");

        // A step to another seat ends, and she steps back first.
        plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, RoomWithDesk());
        plan.AskPlace("Chair");
        RunUntilChange(plan, WanderPlan.MaxRestSeconds, false, false);
        Check(plan.Update(0.5, true, false) == WanderChange.StartApproach, "she steps to the chair");
        plan.SetWatchingScreen(true);
        Check(plan.Update(0.5, false, false) == WanderChange.StandUp, "the activity stops a step to another seat");

        // A walk to a destination turns to the screen place.
        plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, RoomWithDesk());
        RunUntilChange(plan, WanderPlan.MaxRestSeconds, false, false);
        Check(plan.State == WanderState.Walk && plan.Place == null, "she walks to a destination");
        plan.SetWatchingScreen(true);
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk && plan.Place?.Name == "Desk", "the activity turns her walk to the screen place");
        plan.SetWatchingScreen(false);
        Check(plan.Update(0.5, false, false) == WanderChange.EndWalk, "the end of the activity stops the walk to the screen");
        Check(plan.State == WanderState.Rest && plan.Place == null, "she rests where she stopped");

        // An attention that started before the activity ends, and she goes.
        plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, RoomWithDesk());
        Check(plan.Update(0.5, false, true) == WanderChange.StartAttend, "she turns to the viewer");
        plan.SetWatchingScreen(true);
        Check(plan.Update(0.5, false, true) == WanderChange.StartWalk && plan.Place?.Name == "Desk", "the activity ends the attention, and she walks to the screen");

        // A new model during the activity puts her back at the stand point, and she walks to the screen again.
        plan.Update(0.5, true, false);
        plan.Update(0.5, true, false);
        plan.Interrupt();
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk && plan.Place?.Name == "Desk", "after an interruption, she goes to the screen again");
    }

    private static void TestActivityAtAStandingScreen()
    {
        var places = RoomWithDesk();
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, new[] { places[0], places[2] });
        Check(plan.ScreenPlace?.Name == "TV", "a room without a desk takes its TV");
        plan.SetWatchingScreen(true);
        plan.Update(0.5, false, false);
        Check(plan.Update(0.5, true, false) == WanderChange.EndWalk, "at a screen without a seat, she stands");
        Check(plan.LooksAtScreen && plan.Place?.Name == "TV", "she watches the screen while she stands");
        Check(RunUntilChange(plan, WanderPlan.MaxRestSeconds * 2, false, true) == WanderChange.None, "she stands as long as the activity goes on, also during the attention");

        plan.SetWatchingScreen(false);
        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk, "the end of the activity starts the next walk at once");
    }

    private static void TestActivityWithoutScreen()
    {
        var places = RoomWithDesk();
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, new[] { places[0] });
        Check(plan.ScreenPlace == null, "a room with only a seat has no screen place");
        Check(!plan.SetWatchingScreen(true), "a room without a screen place refuses the activity");
        Check(!plan.WatchingScreen, "the refused activity does not start");
        Check(plan.Update(0.5, false, true) == WanderChange.StartAttend, "the viewer still stops her as before");
        Check(plan.SetWatchingScreen(false), "the end of the activity is always fine");
    }
}
